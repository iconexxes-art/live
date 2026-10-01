/* LiveSession — the state machine behind LIVE.
   Owns: committed messages per conversation (persisted), live drafts (memory
   only, never persisted), presence. Local writer actions and remote protocol
   events flow through the same reducer.

   Multi-conversation: one transport channel carries every conversation; the
   session applies only events for the conversation it is viewing. Opening a
   conversation broadcasts DRAFT_RESYNC so a writer already mid-sentence
   re-sends their draft to the late joiner.

   Privacy rules baked in here:
   - discarded drafts exist only in memory and are never stored anywhere
   - committed messages persist per conversation; drafts do not
   - sent messages are ephemeral and dissolve VANISH_TTL_MS after receipt */

import { EventBus, Events, DraftStatus, Visibility } from './events.js';
import { createDraft, createMessage, draftSnapshot, ts } from './model.js';
import { diffOps, applyOps } from './diff.js';
import { getIdentity, getDeviceBundle, encryptForConversation, decryptForConversation, establishRatchetSession, acceptRatchetSession, inspectTransparencySnapshot } from './crypto.js';
import { createRatchetState, encryptRatchet, decryptRatchet } from './ratchet.js';

const PAUSE_AFTER_MS = 1400;
/* "SEND OR DISAPPEAR" — sent messages dissolve this many seconds after they
   are received. expiresAt=null would keep history (reserved for Phase 2). */
const VANISH_TTL_MS = 8000;

export class LiveSession extends EventBus {
  constructor({ transport, users }) {
    super();
    this.transport = transport;
    this.users = users; // AccountStore — display metadata for any author
    this.identity = null;
    this.activeConversation = null;
    this.messages = [];
    this.drafts = new Map();     // `${conversationId}:${authorId}` -> draft
    this.draftsById = new Map(); // draftId -> draft
    this.presence = new Map();   // tabId -> { user, at }
    this.defaultVisibility = {};
    this._seenEvents = new Set();
    this._pauseTimer = null;
    this._heartbeat = null;
    this._unloadBound = () => this._leave();
    this.e2ee = false;
    this.cryptoIdentity = null;
    this.peerKeys = new Map();
    this.ratchets = new Map(); // conversationId:deviceId -> ratchet state
    this.ratchetInit = new Map();
    this.pendingEncrypted = new Map();
    this.deviceBundle = null;
  }

  start() {
    this.transport.onEvent((env) => this._onRemote(env));
    this.transport.onState((s) => this.emit('connection', s));
    this.transport.connect();
    this._announce(false);
    this._heartbeat = setInterval(() => this._announce(true), 7000);
    window.addEventListener('pagehide', this._unloadBound);
  }

  async setIdentity(user) {
    this.identity = user;
    try {
      const v = await fetch('/api/validate'); const data = await v.json();
      this.e2ee = data.e2ee === true;
      if (this.e2ee) {
        this.cryptoIdentity = await getIdentity();
        await fetch('/api/keys', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({publicKey:this.cryptoIdentity.publicKey,deviceId:this.cryptoIdentity.deviceId}) });
        this.deviceBundle = await getDeviceBundle(this.cryptoIdentity);
        await fetch('/api/keys/bundle', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(this.deviceBundle) });
      }
    } catch { this.e2ee = false; }
    this._announce(false);
    this.emit('identity', user);
  }

  /* ---------- conversations ---------- */

  setConversation(conversationId) {
    if (!conversationId) return;
    if (conversationId !== this.activeConversation) {
      this.activeConversation = conversationId;
      this.clearPauseTimer();
      this._announce(false);
      this.emit('conversation', { conversationId });
      /* catch up with anyone already writing in this conversation */
      this._send({ type: Events.DRAFT_RESYNC, conversationId });
    }
    this._loadRemoteMessages();
  }

  /* committed history is owned by the server — every device reads the same
     store, so a conversation opened anywhere shows the same messages */
  async _loadRemoteMessages() {
    const conversationId = this.activeConversation;
    try {
      const res = await fetch(`/api/messages?conversationId=${encodeURIComponent(conversationId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.conversationId !== this.activeConversation) return; // switched meanwhile
      this.messages = Array.isArray(data.messages) ? data.messages : [];
      if (this.e2ee) for (const m of this.messages) {
        if (m.encrypted) { try { const clear=await this._decrypt(conversationId,m.encrypted); Object.assign(m,clear); delete m.encrypted; } catch {} }
        this._scheduleExpiry(m);
      } else for (const m of this.messages) this._scheduleExpiry(m);
    } catch { /* server unreachable — page stays on what it has */ }
    if (conversationId === this.activeConversation) this.emit('messages:loaded', { conversationId });
  }

  async fetchRecents() {
    try {
      const res = await fetch('/api/recents');
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.recents) ? data.recents : [];
    } catch {
      return [];
    }
  }

  partnerOfActive() {
    const id = this.activeConversation;
    if (!id) return null;
    const parts = id.split(':');
    return parts.find((p, i) => i > 0 && p && p !== this.identity?.id) ?? null;
  }

  async _peerKey(conversationId) {
    if (!this.e2ee) return null;
    if (this.peerKeys.has(conversationId)) return this.peerKeys.get(conversationId);
    const partnerId=this.partnerOfConversation(conversationId); const partner=this.users.get(partnerId);
    if (!partner?.username) return null;
    const res=await fetch(`/api/keys?username=${encodeURIComponent(partner.username)}`); if(!res.ok) return null;
    const data=await res.json(); const devices=data.devices||[]; const preferred=devices.find(d=>d.verified)||devices[0]; if(!preferred) return null; this.peerKeys.set(conversationId,preferred.publicKey); return preferred.publicKey;
  }
  async _peerBundles(conversationId) {
    const partnerId=this.partnerOfConversation(conversationId); const partner=this.users.get(partnerId);
    if (!partner?.username) return [];
    await this._refreshTransparency(partner.username);
    const res=await fetch(`/api/keys/bundle?username=${encodeURIComponent(partner.username)}`); if(!res.ok) return [];
    const data=await res.json(); return Array.isArray(data.devices) ? data.devices : [];
  }
  async _refreshTransparency(username) {
    if(!this.e2ee) return false;
    try {
      const res=await fetch(`/api/keys/transparency?username=${encodeURIComponent(username)}`); if(!res.ok) return false;
      const snapshot=await res.json(); const result=await inspectTransparencySnapshot(username,snapshot);
      if(result.changed) this.emit('security:key-transparency-advanced',{username,rootHash:result.rootHash});
      return true;
    } catch(error) {
      this.emit('security:key-transparency-warning',{username,error});
      return false;
    }
  }
  _ratchetKey(conversationId, deviceId) { return `${conversationId}:${deviceId}`; }
  async _encryptRatchetValue(conversationId, value) {
    const bundles=await this._peerBundles(conversationId); const envelopes=[];
    for (const bundle of bundles) {
      const key=this._ratchetKey(conversationId,bundle.deviceId);
      if (!this.ratchets.has(key)) {
        if (this.ratchetInit.has(key)) await this.ratchetInit.get(key);
        else {
          const promise=(async()=>{ const session=await establishRatchetSession(this.cryptoIdentity,bundle,conversationId); this.ratchets.set(key,createRatchetState(session.sendChainKey,session.recvChainKey)); await this._send({type:Events.E2EE_SESSION_INIT,conversationId,session:{targetDeviceId:bundle.deviceId,senderDeviceId:this.cryptoIdentity.deviceId,prekeyId:session.prekeyId,ephemeralPublicKey:session.ephemeralPublicKey}}); })();
          this.ratchetInit.set(key,promise); try { await promise; } finally { this.ratchetInit.delete(key); }
        }
      }
      const state=this.ratchets.get(key); if(!state) continue;
      envelopes.push({deviceId:bundle.deviceId,senderDeviceId:this.cryptoIdentity.deviceId,payload:await encryptRatchet(state,value,conversationId)});
    }
    if (!envelopes.length) throw new Error('No recipient device ratchet available');
    return {mode:'ratchet',version:1,envelopes};
  }
  async _encrypt(conversationId, value) {
    if(!this.e2ee) return null;
    try { return await this._encryptRatchetValue(conversationId,value); }
    catch { const peer=await this._peerKey(conversationId); if(!peer) throw new Error('Peer encryption key unavailable'); return encryptForConversation(this.cryptoIdentity,peer,conversationId,value); }
  }
  async _decrypt(conversationId, encrypted, senderDeviceId=null) {
    if(!this.e2ee || !encrypted) return null;
    if(encrypted.mode==='ratchet' && Array.isArray(encrypted.envelopes)) {
      const mine=encrypted.envelopes.find(e=>e.deviceId===this.cryptoIdentity?.deviceId && (!senderDeviceId || e.senderDeviceId===senderDeviceId));
      if(!mine) throw new Error('No envelope for this device');
      const key=this._ratchetKey(conversationId,mine.senderDeviceId||senderDeviceId||'unknown'); const state=this.ratchets.get(key); if(!state) throw new Error('Ratchet session unavailable');
      return decryptRatchet(state,mine.payload,conversationId);
    }
    const peer=await this._peerKey(conversationId); if(!peer) throw new Error('Peer encryption key unavailable');
    return decryptForConversation(this.cryptoIdentity,peer,conversationId,encrypted);
  }
  partnerOfConversation(conversationId) {
    const parts=String(conversationId||'').split(':'); return parts[1]===this.identity?.id?parts[2]:parts[1];
  }

  /* ---------- writer API (composer) ---------- */

  _send(event) {
    if (this.e2ee && this.cryptoIdentity && event) event.authorDeviceId=this.cryptoIdentity.deviceId;
    return this.transport.send(event);
  }

  _authorSnapshot() {
    const u = this.identity ?? {};
    return { id: u.id, username: u.username, name: u.name, initial: u.initial, bg: u.bg, fg: u.fg, ring: u.ring };
  }

  _draftKey(conversationId, authorId) {
    return `${conversationId}:${authorId}`;
  }

  myDraft() {
    if (!this.identity || !this.activeConversation) return null;
    return this.drafts.get(this._draftKey(this.activeConversation, this.identity.id)) ?? null;
  }

  /* Called on every keystroke. Local state updates synchronously — the
     writer's own UI never waits on the network. */
  editDraft(text, cursor) {
    if (!this.identity || !this.activeConversation) return;
    const conversationId = this.activeConversation;
    let d = this.myDraft();
    if (!d) {
      d = createDraft({
        conversationId,
        authorId: this.identity.id,
        text,
        visibility: this.defaultVisibility[this.identity.id] ?? Visibility.LIVE,
      });
      this.drafts.set(this._draftKey(conversationId, this.identity.id), d);
      this.draftsById.set(d.id, d);
      /* display metadata rides along so peers render the right name/colors */
      const started=draftSnapshot(d); delete started.text;
      this._encrypt(conversationId,{text:d.text}).then(encrypted=>this._send({type:Events.DRAFT_STARTED,conversationId,draft:{...started,encrypted},author:this._authorSnapshot()})).catch(()=>{});
      this.emit('draft:started', { draft: d, self: true });
    }

    const ops = diffOps(d.text, text);
    const resumed = d.status === DraftStatus.PAUSED;
    d.text = text;
    d.cursorPosition = cursor;
    d.updatedAt = ts();
    d.rev += 1;
    d.status = DraftStatus.WRITING;

    const update={type:Events.DRAFT_UPDATED,draftId:d.id,authorId:d.authorId,conversationId,rev:d.rev,ops,visibility:d.visibility,status:d.status,cursorPosition:d.cursorPosition,updatedAt:d.updatedAt};
    if(this.e2ee) this._encrypt(conversationId,{text:d.text}).then(encrypted=>this._send({...update,encrypted})).catch(()=>{}); else this._send({...update,text:d.text});
    this.emit('draft:changed', { draft: d, ops, self: true, resumed });
  }

  pauseDraft() {
    const d = this.myDraft();
    if (!d || d.status !== DraftStatus.WRITING) return;
    d.status = DraftStatus.PAUSED;
    d.updatedAt = ts();
    this._send({
      type: Events.DRAFT_PAUSED,
      draftId: d.id,
      authorId: d.authorId,
      conversationId: d.conversationId,
      updatedAt: d.updatedAt,
    });
    this.emit('draft:paused', { draft: d, self: true });
  }

  armPauseTimer() {
    clearTimeout(this._pauseTimer);
    if (!this.myDraft()) return;
    this._pauseTimer = setTimeout(() => this.pauseDraft(), PAUSE_AFTER_MS);
  }

  clearPauseTimer() {
    clearTimeout(this._pauseTimer);
  }

  setDraftVisibility(visibility) {
    if (this.identity) this.defaultVisibility[this.identity.id] = visibility;
    const d = this.myDraft();
    if (!d || d.visibility === visibility) return;
    d.visibility = visibility;
    d.updatedAt = ts();
    d.rev += 1;
    const update={type:Events.DRAFT_UPDATED,draftId:d.id,authorId:d.authorId,conversationId:d.conversationId,rev:d.rev,ops:[],visibility:d.visibility,status:d.status,cursorPosition:d.cursorPosition,updatedAt:d.updatedAt};
    if(this.e2ee && d.visibility==='LIVE') this._encrypt(d.conversationId,{text:d.text}).then(encrypted=>this._send({...update,encrypted})).catch(()=>{}); else this._send({...update,text:d.text});
    this.emit('draft:changed', { draft: d, ops: [], self: true, visibilityChanged: true });
  }

  sendDraft() {
    const d = this.myDraft();
    if (!d || !d.text.trim()) return null;
    const message = createMessage({
      conversationId: d.conversationId,
      authorId: d.authorId,
      text: d.text,
      ephemeral: true,
      ttlMs: VANISH_TTL_MS,
    });
    d.status = DraftStatus.SENT;
    message.author = this._authorSnapshot();
    this.messages.push(message);
    this._scheduleExpiry(message);
    this.drafts.delete(this._draftKey(d.conversationId, d.authorId));
    this.draftsById.delete(d.id);
    this.clearPauseTimer();
    const base={id:message.id,conversationId:message.conversationId,authorId:message.authorId,createdAt:message.createdAt,via:message.via,ephemeral:message.ephemeral,expiresAt:message.expiresAt,author:message.author};
    if(this.e2ee) this._encrypt(d.conversationId,{text:d.text}).then(encrypted=>this._send({type:Events.DRAFT_SENT,draftId:d.id,authorId:d.authorId,conversationId:d.conversationId,message:{...base,encrypted}})).catch(()=>{}); else this._send({type:Events.DRAFT_SENT,draftId:d.id,authorId:d.authorId,conversationId:d.conversationId,message});
    this.emit('draft:sent', { draft: d, message, self: true });
    this.emit('message:added', { message });
    return message;
  }

  discardDraft() {
    const d = this.myDraft();
    if (!d) return;
    d.status = DraftStatus.DISCARDED;
    this.drafts.delete(this._draftKey(d.conversationId, d.authorId));
    this.draftsById.delete(d.id);
    this.clearPauseTimer();
    /* Deliberately no persistence: a discarded draft never existed for
       history. It is only ever released as an event. */
    this._send({
      type: Events.DRAFT_DISCARDED,
      draftId: d.id,
      authorId: d.authorId,
      conversationId: d.conversationId,
    });
    this.emit('draft:discarded', { draft: d, self: true });
  }

  /* ---------- remote reducer ---------- */

  async _onRemote(env) {
    if (!env?.type) return;
    if (!env._clear && !env._retry && this._seenEvents.has(env.eid)) return; // duplicate suppression
    this._seenEvents.add(env.eid);
    if (this._seenEvents.size > 2000) this._seenEvents.clear();

    if (env.type === Events.E2EE_SESSION_INIT) {
      if (env.session?.targetDeviceId !== this.cryptoIdentity?.deviceId) return;
      try {
        const pair=await acceptRatchetSession(this.cryptoIdentity,env.session,env.conversationId);
        const key=this._ratchetKey(env.conversationId,env.session.senderDeviceId);
        this.ratchets.set(key,createRatchetState(pair.sendChainKey,pair.recvChainKey));
        const pending=this.pendingEncrypted.get(key)||[]; this.pendingEncrypted.delete(key);
        for(const item of pending) this._onRemote({...item,_retry:true});
      } catch {}
      return;
    }

    const queueEncrypted=(senderDeviceId)=>{
      const key=this._ratchetKey(env.conversationId,senderDeviceId||'unknown');
      const list=this.pendingEncrypted.get(key)||[]; list.push(env); if(list.length>100) list.shift(); this.pendingEncrypted.set(key,list);
    };

    switch (env.type) {
      case Events.DRAFT_STARTED: {
        if (env.conversationId !== this.activeConversation) return;
        if (this.e2ee && env.draft?.encrypted) { this._decrypt(env.conversationId,env.draft.encrypted,env.authorDeviceId).then(clear=>this._onRemote({...env,draft:{...env.draft,text:clear.text},_clear:true})).catch((err)=>{ if(String(err?.message).includes('Ratchet session unavailable')) queueEncrypted(env.authorDeviceId); }); return; }
        if (!env.draft?.id) return;
        if (this.draftsById.has(env.draft.id)) return;
        const d = { ...env.draft };
        if (d.visibility !== Visibility.LIVE) d.text = '';
        if (env.author) d.author = env.author;
        this.drafts.set(this._draftKey(d.conversationId, d.authorId), d);
        this.draftsById.set(d.id, d);
        this.emit('draft:started', { draft: d, self: false });
        return;
      }

      case Events.DRAFT_UPDATED: {
        if (env.conversationId !== this.activeConversation) return;
        if (this.e2ee && env.encrypted && !env._clear) { this._decrypt(env.conversationId,env.encrypted,env.authorDeviceId).then(clear=>this._onRemote({...env,text:clear.text,_clear:true})).catch((err)=>{ if(String(err?.message).includes('Ratchet session unavailable')) queueEncrypted(env.authorDeviceId); }); return; }
        const d = this.draftsById.get(env.draftId);
        if (!d) {
          if (env.snapshot && typeof env.text === 'string') {
            this._adoptDraftFromSnapshot(env);
          } else {
            // missed the start (late joiner) — ask the author for a snapshot
            this._send({ type: Events.DRAFT_RESYNC, draftId: env.draftId, conversationId: env.conversationId });
          }
          return;
        }
        if (typeof env.rev === 'number' && env.rev <= d.rev) return; // stale / out of order
        let next;
        try {
          next = env.ops?.length ? applyOps(d.text, env.ops) : d.text;
        } catch {
          next = env.text;
        }
        if (d.visibility !== Visibility.LIVE) next = '';
        else if (typeof env.text === 'string') next = env.text; // converge on snapshot
        d.text = next;
        d.visibility = env.visibility ?? d.visibility;
        d.status = env.status ?? d.status;
        d.cursorPosition = env.cursorPosition ?? d.cursorPosition;
        d.updatedAt = env.updatedAt ?? ts();
        d.rev = env.rev ?? d.rev + 1;
        this.emit('draft:changed', { draft: d, ops: env.ops ?? [], self: false });
        return;
      }

      case Events.DRAFT_PAUSED: {
        if (env.conversationId !== this.activeConversation) return;
        const d = this.draftsById.get(env.draftId);
        if (!d) return;
        d.status = DraftStatus.PAUSED;
        d.updatedAt = env.updatedAt ?? ts();
        this.emit('draft:paused', { draft: d, self: false });
        return;
      }

      case Events.DRAFT_SENT: {
        if (env.conversationId !== this.activeConversation) return;
        if (this.e2ee && env.message?.encrypted && !env._clear) { this._decrypt(env.conversationId,env.message.encrypted,env.authorDeviceId).then(clear=>this._onRemote({...env,message:{...env.message,text:clear.text},_clear:true})).catch((err)=>{ if(String(err?.message).includes('Ratchet session unavailable')) queueEncrypted(env.authorDeviceId); }); return; }
        const d = this.draftsById.get(env.draftId);
        if (d) {
          d.status = DraftStatus.SENT;
          this.drafts.delete(this._draftKey(d.conversationId, d.authorId));
          this.draftsById.delete(d.id);
        }
        this.messages.push(env.message);
        this._scheduleExpiry(env.message);
        this.emit('draft:sent', { draft: d, message: env.message, self: false });
        this.emit('message:added', { message: env.message });
        return;
      }

      case Events.DRAFT_DISCARDED:
      case Events.DRAFT_DELETED: {
        if (env.conversationId !== this.activeConversation) return;
        const d = this.draftsById.get(env.draftId);
        if (!d) return;
        d.status = DraftStatus.DISCARDED;
        this.drafts.delete(this._draftKey(d.conversationId, d.authorId));
        this.draftsById.delete(d.id);
        this.emit('draft:discarded', { draft: d, self: false });
        return;
      }

      case Events.DRAFT_RESYNC: {
        if (env.conversationId && env.conversationId !== this.activeConversation) return;
        const mine = env.draftId
          ? this.draftsById.get(env.draftId)
          : this.myDraft();
        if (mine && this.identity && mine.authorId === this.identity.id) {
          this._sendDraftSnapshot(mine);
        }
        return;
      }

      case Events.MESSAGE_EXPIRED: {
        const message = this.messages.find((m) => m.id === env.message?.id);
        if (!message) return;
        this._expireMessage(env.message.id);
        return;
      }

      case Events.USER_JOINED:
      case Events.PRESENCE_PING: {
        this.presence.set(env.tabId, { user: env.user, at: Date.now() });
        this._prunePresence();
        this.emit('presence:changed');
        return;
      }

      case Events.USER_LEFT: {
        this.presence.delete(env.tabId);
        this.emit('presence:changed');
        return;
      }
    }
  }

  /* a resync snapshot can arrive for a draft whose DRAFT_STARTED we missed */
  _adoptDraftFromSnapshot(env) {
    const d = createDraft({
      conversationId: env.conversationId,
      authorId: env.authorId,
      text: env.text,
      visibility: env.visibility ?? Visibility.LIVE,
    });
    d.id = env.draftId;
    d.rev = env.rev ?? 0;
    d.status = env.status ?? DraftStatus.WRITING;
    d.updatedAt = env.updatedAt ?? ts();
    d.startedAt = d.updatedAt;
    if (env.author) d.author = env.author;
    this.drafts.set(this._draftKey(d.conversationId, d.authorId), d);
    this.draftsById.set(d.id, d);
    this.emit('draft:started', { draft: d, self: false });
  }

  _sendDraftSnapshot(d) {
    this._send({
      type: Events.DRAFT_UPDATED,
      draftId: d.id,
      authorId: d.authorId,
      conversationId: d.conversationId,
      rev: d.rev,
      ops: [],
      text: d.text,
      visibility: d.visibility,
      status: d.status,
      cursorPosition: d.cursorPosition,
      updatedAt: d.updatedAt,
      snapshot: true,
      author: this._authorSnapshot(),
    });
  }

  /* ---------- presence ---------- */

  _announce(ping) {
    if (!this.identity || !this.activeConversation) return;
    this._send({
      type: ping ? Events.PRESENCE_PING : Events.USER_JOINED,
      user: this._authorSnapshot(),
      conversationId: this.activeConversation,
    });
    this.presence.set(this.transport.tabId, { user: this.identity, at: Date.now() });
    this._prunePresence();
    this.emit('presence:changed');
  }

  _prunePresence() {
    const cutoff = Date.now() - 25000;
    for (const [tabId, p] of this.presence) {
      if (p.at < cutoff) this.presence.delete(tabId);
    }
  }

  _leave() {
    this.clearPauseTimer();
    const d = this.myDraft();
    if (d) {
      // leaving without sending: the draft vanishes for everyone
      this._send({ type: Events.DRAFT_DISCARDED, draftId: d.id, authorId: d.authorId, conversationId: d.conversationId });
    }
    this._send({ type: Events.USER_LEFT, conversationId: this.activeConversation });
  }

  /* ---------- ephemeral messages ---------- */

  /* Every client dissolves a received message independently once its
     expiresAt passes — no central timer, survives reloads and offline use. */
  _scheduleExpiry(message) {
    if (!message?.expiresAt) return;
    const delay = Math.max(0, message.expiresAt - Date.now());
    setTimeout(() => this._expireMessage(message.id), delay);
  }

  _expireMessage(id) {
    const message = this.messages.find((m) => m.id === id);
    if (!message) return; // already dissolved here, or never received
    this.messages = this.messages.filter((m) => m.id !== id);
    /* history lives on the server; the server also sweeps expiry and
       broadcasts message.expired so every device dissolves in step */
    this.emit('message:expired', { message });
  }

  /* ---------- persistence ----------
     Committed messages live on the server (data/conversations.json): the
     server appends them on draft.sent relay, serves GET /api/messages, and
     sweeps expired ones. Drafts are never stored anywhere. */
}
