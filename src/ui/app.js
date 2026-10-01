/* AppUI — wires the session and renderer to the composer, account chip,
   people directory (username search), profile panel, search, visibility
   control, navigation and toasts. */

import { dmId, ACCENTS } from '../users.js';
import { avatarEl } from './avatar.js';
import { fmtRel } from './util.js';
import { Visibility } from '../core/events.js';

const TWO_DEVICE_HINT_KEY = 'live.proto.twoDeviceHint';

export class AppUI {
  constructor(session, renderer, accounts) {
    this.session = session;
    this.renderer = renderer;
    this.accounts = accounts;
    this.$ = (sel) => document.querySelector(sel);
    this.$$ = (sel) => [...document.querySelectorAll(sel)];
    this._profileMode = 'edit';
    this._profileAccent = 'cyan';
    this._mounted = false;
  }

  mount() {
    this.ta = this.$('#composerInput');
    this.sendBtn = this.$('#sendBtn');
    this.plusBtn = this.$('#plusBtn');
    this.connDot = this.$('#connDot');
    this.connLabel = this.$('#connLabel');
    this.presenceLabel = this.$('#presenceLabel');
    this.convTitle = this.$('#convTitle');
    this.accountChip = this.$('#accountChip');
    this.profileOverlay = this.$('#profileOverlay');
    this.profileName = this.$('#profileName');
    this.roomsOverlay = this.$('#roomsOverlay');
    this.peopleSearch = this.$('#peopleSearch');
    this.peopleList = this.$('#peopleList');
    this.alertsOverlay = this.$('#alertsOverlay');
    this.alertsList = this.$('#alertsList');
    this.toastsEl = this.$('#toasts');
    this.segEls = this.$$('.seg[data-vis]');
    this.navEls = this.$$('.nav-item');

    /* home screen: recent chats (people only — no message content anywhere) */
    this._recents = [];
    this._incomingRequests = [];
    this._activity = []; // live notification feed (requests, acceptances, declines)
    this.renderer.buildHome = (container) => this._buildHome(container);

    this._bindComposer();
    this._bindVisibility();
    this._bindNav();
    this._bindProfilePanel();
    this._bindRooms();
    this._bindAlerts();
    this._bindAccountChip();
    this._bindSession();

    setTimeout(() => {
      if (!localStorage.getItem(TWO_DEVICE_HINT_KEY)) {
        this.toast('Find people by their exact username — they decide who can chat with them');
        localStorage.setItem(TWO_DEVICE_HINT_KEY, '1');
      }
    }, 1200);
  }

  /* ---------- header: account chip + conversation title ---------- */

  _bindAccountChip() {
    this.$('#logoutBtn').addEventListener('click', () => {
      this.accounts.clearCurrent();
      location.reload();
    });
  }

  _renderAccountChip(user) {
    this.accountChip.textContent = '';
    this.accountChip.append(avatarEl(user, 22));
    const label = document.createElement('span');
    label.textContent = `@${user.username}`;
    this.accountChip.append(label);
  }

  _renderConvTitle() {
    const partnerId = this.session.partnerOfActive();
    const partner = partnerId ? this.accounts.get(partnerId) : null;
    if (partner) {
      this.convTitle.textContent = `${this.session.identity?.name ?? 'You'} & ${partner.name}`;
    } else {
      this.convTitle.textContent = 'Pick someone to talk to';
    }
  }

  /* ---------- composer ---------- */

  _bindComposer() {
    const ta = this.ta;

    ta.addEventListener('input', () => {
      const text = ta.value;
      if (text.length === 0) {
        // clearing the draft makes it vanish for everyone — by design
        if (this.session.myDraft()) this.session.discardDraft();
      } else {
        this.session.editDraft(text, ta.selectionStart);
        this.session.armPauseTimer();
      }
      this._syncComposerState();
      this._fitComposer();
    });

    ta.addEventListener('blur', () => this.session.pauseDraft());

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const had = !!this.session.myDraft();
        if (had) {
          this.session.discardDraft();
          this.toast('Draft discarded — it was never part of the conversation');
        }
        ta.value = '';
        this._syncComposerState();
        this._fitComposer();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this._send();
      }
    });

    this.sendBtn.addEventListener('click', () => this._send());

    this.plusBtn.addEventListener('click', () =>
      this.toast('Attachments arrive in a later phase — LIVE is writing-first for now'));
  }

  _send() {
    const message = this.session.sendDraft();
    if (!message) return;
    this.ta.value = '';
    this._syncComposerState();
    this._fitComposer();
    this.ta.focus();
  }

  _syncComposerState() {
    const active = !!this.session.activeConversation;
    this.ta.disabled = !active;
    this.sendBtn.disabled = !active || !this.ta.value.trim();
    this.ta.placeholder = active ? 'Write here…' : 'Choose someone from PEOPLE first…';
  }

  _fitComposer() {
    const ta = this.ta;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }

  /* ---------- draft visibility ---------- */

  _bindVisibility() {
    for (const seg of this.segEls) {
      seg.addEventListener('click', () => {
        const vis = seg.dataset.vis;
        this.session.setDraftVisibility(vis);
        this._setSegUI(vis);
        if (vis === Visibility.PRIVATE) {
          this.toast('Private draft — the other side only sees that you are writing');
        } else if (vis === Visibility.OFF) {
          this.toast('Sharing off — nothing about this draft is visible');
        } else if (this.session.myDraft()) {
          this.toast('Live — your words are visible as you write');
        }
      });
    }
  }

  _setSegUI(vis) {
    for (const seg of this.segEls) {
      const active = seg.dataset.vis === vis;
      seg.classList.toggle('is-active', active);
      seg.setAttribute('aria-checked', String(active));
    }
  }

  /* ---------- notifications (ALERTS) ---------- */

  _bindAlerts() {
    this.$('#alertsClose').addEventListener('click', () => this._closeAlerts());
    this.alertsOverlay.addEventListener('click', (e) => {
      if (e.target === this.alertsOverlay) this._closeAlerts();
    });
  }

  _openAlerts() {
    this._renderAlerts();
    this.alertsOverlay.hidden = false;
    this._refreshRequests();
  }

  _closeAlerts() {
    this.alertsOverlay.hidden = true;
    this.ta.focus();
  }

  _renderAlerts() {
    const list = this.alertsList;
    list.textContent = '';
    const incoming = this._incomingRequests ?? [];

    if (incoming.length) {
      const label = document.createElement('div');
      label.className = 'people-section';
      label.textContent = 'Chat requests';
      list.append(label);
      for (const req of incoming) {
        const row = document.createElement('div');
        row.className = 'people-row static alert-row';
        row.append(avatarEl(req.user, 34));
        const text = document.createElement('span');
        text.className = 'people-text';
        const name = document.createElement('span');
        name.className = 'people-name';
        name.textContent = req.user.name;
        const handle = document.createElement('span');
        handle.className = 'people-handle';
        handle.textContent = `@${req.user.username} · wants to chat with you`;
        text.append(name, handle);
        row.append(text);
        const actions = document.createElement('span');
        actions.className = 'row-actions';
        actions.append(...this._acceptDeclineButtons(req.requestId, req.user.id));
        row.append(actions);
        list.append(row);
      }
    }

    if (this._activity.length) {
      const label = document.createElement('div');
      label.className = 'people-section';
      label.textContent = 'Recent activity';
      list.append(label);
      for (const item of this._activity) {
        const row = document.createElement('div');
        row.className = 'alert-item';
        row.textContent = item.text;
        const time = document.createElement('span');
        time.className = 'alert-time';
        time.textContent = fmtRel(item.at);
        row.append(time);
        list.append(row);
      }
    }

    if (!incoming.length && !this._activity.length) {
      const empty = document.createElement('div');
      empty.className = 'people-empty';
      empty.textContent = 'You\'re all caught up. When someone asks to chat with you, it shows up here.';
      list.append(empty);
    }
  }

  /* ---------- bottom navigation ---------- */

  _bindNav() {
    for (const item of this.navEls) {
      item.addEventListener('click', () => {
        const nav = item.dataset.nav;
        if (nav === 'LIVE') return;
        if (nav === 'ROOMS') {
          this._openRooms();
          return;
        }
        if (nav === 'ALERTS') {
          this._openAlerts();
          return;
        }
        if (nav === 'YOU') {
          this._openProfile();
          return;
        }
      });
    }
    /* pending chat-request badge on ALERTS */
    const alerts = this.navEls.find((i) => i.dataset.nav === 'ALERTS');
    if (alerts) {
      this._alertsBadge = document.createElement('span');
      this._alertsBadge.className = 'nav-badge';
      this._alertsBadge.hidden = true;
      alerts.append(this._alertsBadge);
    }
  }

  /* live notification feed (session-scoped) */
  _pushActivity(text) {
    this._activity.unshift({ text, at: Date.now() });
    if (this._activity.length > 20) this._activity.length = 20;
  }

  /* ---------- find people: exact-username search + permission requests ---------- */

  _bindRooms() {
    this.$('#roomsClose').addEventListener('click', () => this._closeRooms());
    this.roomsOverlay.addEventListener('click', (e) => {
      if (e.target === this.roomsOverlay) this._closeRooms();
    });
    this.peopleSearch.addEventListener('input', () => {
      clearTimeout(this._findTimer);
      const q = this.peopleSearch.value;
      if (!q.trim()) {
        this._renderFind('');
        return;
      }
      this._findTimer = setTimeout(() => this._renderFind(q), 250);
    });
  }

  _openRooms() {
    this.peopleSearch.value = '';
    this._renderFind('');
    this.roomsOverlay.hidden = false;
    this.peopleSearch.focus();
    this._refreshRequests();
  }

  _closeRooms() {
    this.roomsOverlay.hidden = true;
    this.ta.focus();
  }

  _refreshRequests() {
    this.accounts.fetchRequests()
      .then(({ incoming }) => {
        this._incomingRequests = incoming;
        this._updateRequestBadge();
        if (!this.roomsOverlay.hidden) this._renderFind(this.peopleSearch.value);
        if (!this.alertsOverlay.hidden) this._renderAlerts();
      })
      .catch(() => { /* offline — badge stays as-is */ });
  }

  _updateRequestBadge() {
    if (!this._alertsBadge) return;
    const count = (this._incomingRequests ?? []).length;
    this._alertsBadge.hidden = count === 0;
    this._alertsBadge.textContent = String(count);
  }

  /* exact-username lookup only: no directory, no name until they accept */
  _renderFind(query) {
    const list = this.peopleList;
    list.textContent = '';
    const q = String(query ?? '').trim();

    if (!q) {
      this._renderRequestsInbox(list);
      const hint = document.createElement('div');
      hint.className = 'people-empty';
      hint.textContent = 'People are never listed here. Type someone\'s exact username — they decide whether you can chat.';
      list.append(hint);
      return;
    }

    const seq = (this._findSeq = (this._findSeq ?? 0) + 1);
    this.accounts.findUser(q)
      .then((res) => {
        if (seq !== this._findSeq || this.roomsOverlay.hidden) return;
        list.textContent = '';
        if (!res.found) {
          const none = document.createElement('div');
          none.className = 'people-empty';
          none.textContent = `No one with the exact username “${q}”.`;
          list.append(none);
          return;
        }
        /* render from the cache (findUser normalized it) — the raw payload
           for non-connected matches is intentionally minimal */
        const row = this._findRow({ ...res, account: this.accounts.get(res.account.id) ?? res.account });
        list.append(row);
      })
      .catch((err) => {
        if (seq !== this._findSeq) return;
        list.textContent = '';
        const none = document.createElement('div');
        none.className = 'people-empty';
        none.textContent = err?.message ?? 'Lookup failed.';
        list.append(none);
      });
  }

  _findRow(res) {
    const { relation, account } = res;
    const revealed = relation === 'connected' || relation === 'self';
    const row = document.createElement('div');
    row.className = 'people-row static';
    row.append(avatarEl(account, 30));

    const text = document.createElement('span');
    text.className = 'people-text';
    const name = document.createElement('span');
    name.className = 'people-name';
    name.textContent = revealed ? account.name : `@${account.username}`;
    const handle = document.createElement('span');
    handle.className = 'people-handle';
    handle.textContent = revealed ? `@${account.username}` : 'name hidden until they accept';
    text.append(name, handle);
    row.append(text);

    const actions = document.createElement('span');
    actions.className = 'row-actions';
    const myId = this.session.identity?.id;

    if (relation === 'self') {
      const tag = document.createElement('span');
      tag.className = 'people-handle';
      tag.textContent = 'this is you';
      actions.append(tag);
    } else if (relation === 'connected') {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn-mini accent';
      open.textContent = 'OPEN CHAT';
      open.addEventListener('click', () => {
        if (!myId) return;
        this.roomsOverlay.hidden = true;
        this.session.setConversation(dmId(myId, account.id));
      });
      actions.append(open);
    } else if (relation === 'outgoing') {
      const tag = document.createElement('span');
      tag.className = 'people-handle';
      tag.textContent = 'request pending…';
      actions.append(tag);
    } else if (relation === 'incoming') {
      actions.append(...this._acceptDeclineButtons(res.requestId, res.account.id));
    } else {
      const ask = document.createElement('button');
      ask.type = 'button';
      ask.className = 'btn-mini accent';
      ask.textContent = 'REQUEST TO CHAT';
      ask.addEventListener('click', () => {
        this.accounts.sendRequest(account.id)
          .then(() => {
            this.toast('Request sent — they decide');
            this._renderFind(this.peopleSearch.value);
          })
          .catch((err) => this.toast(err?.message ?? 'Could not send request'));
      });
      actions.append(ask);
    }

    row.append(actions);
    return row;
  }

  _renderRequestsInbox(list) {
    const incoming = this._incomingRequests ?? [];
    if (!incoming.length) return;
    const label = document.createElement('div');
    label.className = 'people-section';
    label.textContent = 'They want to chat with you';
    list.append(label);
    for (const req of incoming) {
      const row = document.createElement('div');
      row.className = 'people-row static';
      row.append(avatarEl(req.user, 30));
      const text = document.createElement('span');
      text.className = 'people-text';
      const name = document.createElement('span');
      name.className = 'people-name';
      name.textContent = req.user.name;
      const handle = document.createElement('span');
      handle.className = 'people-handle';
      handle.textContent = `@${req.user.username} · wants to chat`;
      text.append(name, handle);
      row.append(text);
      const actions = document.createElement('span');
      actions.className = 'row-actions';
      actions.append(...this._acceptDeclineButtons(req.requestId, req.user.id));
      row.append(actions);
      list.append(row);
    }
  }

  /* accept always links both people and opens the chat; decline just closes it */
  _acceptDeclineButtons(requestId, fromId) {
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'btn-mini accent';
    accept.textContent = 'ACCEPT';
    accept.addEventListener('click', () => {
      this.accounts.acceptRequest(requestId)
        .then((data) => {
          const other = data.account;
          this._refreshRequests();
          this._pushActivity(`You accepted @${other?.username ?? 'their'} request`);
          this.toast(`You and @${other?.username ?? 'they'} are connected`);
          this.alertsOverlay.hidden = true;
          this.roomsOverlay.hidden = true;
          const myId = this.session.identity?.id;
          if (myId && other?.id) this.session.setConversation(dmId(myId, other.id));
        })
        .catch((err) => this.toast(err?.message ?? 'Could not accept'));
    });
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'btn-mini';
    decline.textContent = 'DECLINE';
    decline.addEventListener('click', () => {
      this.accounts.declineRequest(requestId)
        .then(() => {
          this._pushActivity('Request declined');
          this._refreshRequests();
        })
        .catch((err) => this.toast(err?.message ?? 'Could not decline'));
    });
    return [accept, decline];
  }

  /* home screen: recent chats — people only, never message content */
  _buildHome(container) {
    const wrap = document.createElement('div');
    wrap.className = 'home';

    const title = document.createElement('div');
    title.className = 'home-title';
    title.textContent = 'Recent chats';
    wrap.append(title);

    const recents = this._recents ?? [];
    if (!recents.length) {
      const empty = document.createElement('div');
      empty.className = 'home-empty';
      empty.textContent = 'No chats yet — messages dissolve, so only the people you talked to stay here.';
      wrap.append(empty);
    } else {
      for (const r of recents) {
        const partner = this.accounts.get(r.partnerId);
        if (!partner) continue;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'people-row home-row';
        row.append(avatarEl(partner, 34));
        const text = document.createElement('span');
        text.className = 'people-text';
        const name = document.createElement('span');
        name.className = 'people-name';
        name.textContent = partner.name;
        const handle = document.createElement('span');
        handle.className = 'people-handle';
        handle.textContent = `@${partner.username} · ${fmtRel(r.lastAt)}`;
        text.append(name, handle);
        row.append(text);
        row.addEventListener('click', () => {
          const myId = this.session.identity?.id;
          if (!myId) return;
          this.session.setConversation(r.conversationId);
        });
        wrap.append(row);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'home-actions';
    const findBtn = document.createElement('button');
    findBtn.type = 'button';
    findBtn.className = 'send-btn';
    findBtn.textContent = 'FIND SOMEONE';
    findBtn.addEventListener('click', () => this._openRooms());
    actions.append(findBtn);
    wrap.append(actions);

    container.append(wrap);
  }

  /* ---------- profile page: identity card with live preview ---------- */

  _bindProfilePanel() {
    this.$('#profileClose').addEventListener('click', () => this._closeProfile());
    this.profileOverlay.addEventListener('click', (e) => {
      if (e.target === this.profileOverlay) this._closeProfile();
    });
    this.$('#profileNew').addEventListener('click', () => {
      this._closeProfile();
      this.toast('Log out and sign up — every account is a new person on this server');
    });
    this.$('#profileSave').addEventListener('click', () => this._saveProfile());
    this.profileName.addEventListener('input', () => this._renderProfilePreview());
    this.profileName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._saveProfile();
    });
  }

  _openProfile() {
    const account = this.profiles_account();
    this.profileName.value = account?.name ?? '';
    this._profileAccent = account?.accent ?? 'cyan';
    this._renderSwatches();
    this._renderProfilePreview();
    this.$('#profileMeta').textContent = account?.createdAt
      ? `On LIVE since ${new Date(account.createdAt).toLocaleDateString([], { month: 'long', year: 'numeric' })}`
      : '';
    this.profileOverlay.hidden = false;
    this.profileName.focus();
  }

  profiles_account() {
    return this.accounts.get(this.session.identity?.id);
  }

  _closeProfile() {
    this.profileOverlay.hidden = true;
    this.ta.focus();
  }

  hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex ?? '');
    if (!m) return `rgba(89, 210, 255, ${alpha})`;
    return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
  }

  /* live preview: name + accent repaint the identity card as you edit */
  _renderProfilePreview() {
    const account = this.profiles_account();
    const accent = ACCENTS[this._profileAccent] ?? ACCENTS.cyan;
    const name = this.profileName.value.trim() || account?.name || account?.username || '—';
    const preview = {
      ...(account ?? {}),
      name,
      initial: name[0].toUpperCase(),
      ...accent,
    };
    const slot = this.$('#profileAvatar');
    slot.textContent = '';
    slot.append(avatarEl(preview, 72));
    this.$('#profileNamePreview').textContent = name;
    this.$('#profileHandlePreview').textContent = `@${account?.username ?? 'you'}`;
    this.$('#profileHero').style.background =
      `radial-gradient(130% 150% at 50% -30%, ${this.hexToRgba(accent.fg, 0.16)}, transparent 72%)`;
  }

  _renderSwatches() {
    const wrap = this.$('#profileSwatches');
    wrap.textContent = '';
    for (const [id, colors] of Object.entries(ACCENTS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (id === this._profileAccent ? ' is-active' : '');
      b.dataset.accent = id;
      b.style.background = colors.fg;
      b.title = id;
      b.setAttribute('aria-label', `Accent ${id}`);
      b.addEventListener('click', () => {
        this._profileAccent = id;
        this._renderSwatches();
        this._renderProfilePreview();
      });
      wrap.append(b);
    }
  }

  _saveProfile() {
    const name = this.profileName.value.trim();
    if (!name) {
      this.toast('Give the profile a name first');
      this.profileName.focus();
      return;
    }
    this.accounts.updateProfile(this.session.identity.id, { name, accent: this._profileAccent })
      .then((updated) => {
        this.session.setIdentity(updated);
        this._renderAccountChip(updated);
        this._renderProfilePreview();
        this.toast('Profile saved — every device sees it');
      })
      .catch((err) => this.toast(err?.message ?? 'Could not save profile'));
  }

  /* called by main once the server directory cache is warm — the home
     screen, conversation title and chip can now resolve partner names */
  onAccountsRefreshed() {
    this._renderConvTitle();
    if (!this.roomsOverlay.hidden) this._renderFind(this.peopleSearch.value);
    if (!this.session.activeConversation) this.renderer.renderAll();
  }

  /* ---------- session → chrome ---------- */

  _bindSession() {
    const s = this.session;

    s.on('identity', (user) => this._onIdentity(user));
    s.on('conversation', ({ conversationId }) => this._onConversation(conversationId));
    s.on('messages:loaded', () => this.renderer.renderAll());

    s.on('connection', (state) => {
      if (state === 'unauthorized') {
        this.accounts.clearCurrent();
        location.reload();
        return;
      }
      const labels = { live: 'realtime', connecting: 'connecting…', offline: 'offline', degraded: 'unstable link' };
      this.connDot.classList.toggle('live', state === 'live');
      this.connLabel.textContent = labels[state] ?? state;
    });

    s.on('security:key-transparency-advanced', ({username}) => {
      this.toast(`Security notice: @${username} changed their device-key history.`);
    });
    s.on('security:key-transparency-warning', ({username}) => {
      this.toast(`Security warning: could not verify @${username}'s device-key history.`);
    });

    s.on('presence:changed', () => {
      const n = s.presence.size;
      this.presenceLabel.textContent = `${n} online`;
    });
  }

  _onIdentity(user) {
    this._renderAccountChip(user);
    this.ta.value = this.session.myDraft()?.text ?? '';
    this._fitComposer();
    this._syncComposerState();
    const vis = this.session.myDraft()?.visibility ?? this.session.defaultVisibility[user.id] ?? Visibility.LIVE;
    this._setSegUI(vis);
    this.renderer.renderAll();
    this._renderConvTitle();
    if (this._mounted) this.toast(`Writing as ${user.name} (@${user.username})`);
    this._refreshRequests();

    /* home screen shows recent chats — never auto-jump into one */
    if (!this.session.activeConversation) {
      this.session.fetchRecents()
        .then((recents) => {
          this._recents = recents;
          if (!this.session.activeConversation) this.renderer.renderAll();
        })
        .catch(() => this.renderer.renderAll());
    }
    this._mounted = true;
  }

  /* wire events that are UI-facing rather than conversation state */
  onWireEvent(env) {
    const myId = this.session.identity?.id;
    if (!myId) return;

    if (env.type === 'request.incoming' && env.request?.to === myId) {
      this._refreshRequests();
      this._pushActivity(`@${env.user?.username ?? 'someone'} asked to chat with you`);
      this.toast(`@${env.user?.username ?? 'someone'} wants to chat with you`);
    }
    if (env.type === 'request.accepted' && (env.request?.from === myId || env.request?.to === myId)) {
      this._refreshRequests();
      const other = env.user?.username ?? this.accounts.get(env.request.from === myId ? env.request.to : env.request.from)?.username ?? 'they';
      this._pushActivity(`@${other} accepted your chat request`);
      this.toast(`@${other} accepted — you can chat now`);
      this.session.fetchRecents()
        .then((recents) => {
          this._recents = recents;
          if (!this.session.activeConversation) this.renderer.renderAll();
        })
        .catch(() => {});
    }
    if (env.type === 'request.declined' && env.request?.from === myId) {
      this._pushActivity('Your chat request was declined');
      this.toast('Your chat request was declined');
      this._refreshRequests();
    }
  }

  _onConversation(conversationId) {
    this.roomsOverlay.hidden = true;
    this.ta.value = this.session.myDraft()?.text ?? '';
    this._fitComposer();
    this._syncComposerState();
    const vis = this.session.myDraft()?.visibility
      ?? this.session.defaultVisibility[this.session.identity?.id]
      ?? Visibility.LIVE;
    this._setSegUI(vis);
    this.renderer.renderAll();
    this.renderer.staggerEnter();
    this._renderConvTitle();
    const partnerId = this.session.partnerOfActive();
    const partner = partnerId ? this.accounts.get(partnerId) : null;
    if (partner && this._mounted) this.toast(`Live with ${partner.name} — @${partner.username}`);
    this.ta.focus();
  }

  /* ---------- toasts ---------- */

  toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    this.toastsEl.append(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3000);
    while (this.toastsEl.children.length > 3) this.toastsEl.firstChild.remove();
  }
}
