/* PageRenderer — turns session events into the living page.
   Committed messages are plain entries on the page. Live drafts are the same
   entries in a still-wet state: outlined, cursor breathing, text updated via
   incremental ops so new words surface and deletions dissolve smoothly. */

import { avatarEl } from './avatar.js';
import { fmtTime, prefersReducedMotion } from './util.js';

const MODE = { TEXT: 'text', GHOST: 'ghost', NONE: 'none' };

export class PageRenderer {
  constructor(container, session) {
    this.container = container;
    this.session = session;
    this.draftEls = new Map(); // draftId -> { el, text, vis, cursor, chip, timeEl, footEl, cleanup }
    this.msgEls = new Map();   // messageId -> el

    const s = session;
    s.on('draft:started', ({ draft }) => this._ensureDraft(draft, true));
    s.on('draft:changed', ({ draft, ops }) => this._updateDraft(draft, ops));
    s.on('draft:paused', ({ draft }) => this._setPaused(draft, true));
    s.on('draft:sent', ({ draft, message }) => this._commit(draft, message));
    s.on('draft:discarded', ({ draft }) => this._remove(draft.id));
    s.on('message:added', ({ message }) => {
      if (!this.msgEls.has(message.id)) this._addMessage(message, true);
    });
    s.on('message:expired', ({ message }) => this._expire(message));
  }

  /* ---------- full rebuild (boot, identity switch) ---------- */

  renderAll() {
    this.container.textContent = '';
    this.draftEls.clear();
    this.msgEls.clear();

    const active = this.session.activeConversation;
    const items = [];
    for (const m of this.session.messages) items.push({ key: m.createdAt, kind: 'msg', m });
    for (const d of this.session.drafts.values()) {
      if (d.conversationId === active) items.push({ key: d.startedAt, kind: 'draft', d });
    }
    items.sort((a, b) => a.key - b.key);

    for (const it of items) {
      if (it.kind === 'msg') this._addMessage(it.m, false);
      else this._ensureDraft(it.d, false);
    }

    if (!this.container.children.length) {
      if (!active && this.buildHome) {
        this.buildHome(this.container);
      } else {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = active
          ? 'This conversation is brand new. Start writing — your words appear here live, before you send anything.'
          : 'Welcome to LIVE. Open FIND, look someone up by their exact username, and ask to chat.';
        this.container.append(empty);
      }
    }

    this._stick(true);
  }

  /* replay the entrance cascade over already-rendered entries (conversation open) */
  staggerEnter() {
    let i = 0;
    for (const el of this.container.children) {
      if (!el.classList.contains('entry') || prefersReducedMotion()) continue;
      el.style.animationDelay = `${i * 70}ms`;
      el.classList.add('enter');
      el.addEventListener('animationend', () => { el.style.animationDelay = ''; }, { once: true });
      i++;
    }
  }

  /* ---------- committed messages ---------- */

  _addMessage(message, animate) {
    if (this.msgEls.has(message.id)) return;
    const author = this._author(message.authorId, message.author);
    const isSelf = message.authorId === this.session.identity?.id;
    const el = document.createElement('article');
    el.className = `entry committed ${isSelf ? 'mine' : 'theirs'}`;

    const head = document.createElement('header');
    head.className = 'entry-head';
    head.append(avatarEl(author, 24));
    const name = document.createElement('span');
    name.className = 'entry-author';
    name.textContent = author.name;
    const time = document.createElement('span');
    time.className = 'entry-time';
    time.textContent = fmtTime(message.createdAt);
    head.append(name, time);

    const body = document.createElement('div');
    body.className = 'entry-body';
    const p = document.createElement('p');
    p.className = 'entry-text';
    p.textContent = message.text;
    body.append(p);

    const foot = document.createElement('div');
    foot.className = 'entry-foot reveal';
    foot.textContent = this._caption(message);

    el.append(head, body, foot);
    this._insertSorted(el, message.createdAt);
    if (animate) el.classList.add('enter');
    this._scheduleExpireVisual(el, message);
    this.msgEls.set(message.id, el);
    this._stick();
  }

  /* ---------- live drafts ---------- */

  _modeFor(draft) {
    if (draft.authorId === this.session.identity?.id) return MODE.TEXT; // own mirror, always visible
    if (draft.visibility === 'LIVE') return MODE.TEXT;
    if (draft.visibility === 'PRIVATE') return MODE.GHOST;
    return MODE.NONE;
  }

  _ensureDraft(draft, animate) {
    if (this.draftEls.has(draft.id)) return;
    const mode = this._modeFor(draft);
    if (mode === MODE.NONE) return;

    const author = this._author(draft.authorId, draft.author);
    const self = draft.authorId === this.session.identity?.id;
    const el = document.createElement('article');
    el.className = `entry draft ${self ? 'mine' : 'theirs'}`;

    // header
    const head = document.createElement('header');
    head.className = 'entry-head';
    head.append(avatarEl(author, 24));
    const name = document.createElement('span');
    name.className = 'entry-author';
    name.textContent = author.name;
    const chip = document.createElement('span');
    chip.className = 'chip';
    const pause = document.createElement('span');
    pause.className = 'pause-note';
    pause.textContent = 'paused';
    const time = document.createElement('span');
    time.className = 'entry-time';
    time.textContent = fmtTime(draft.updatedAt);
    head.append(name, chip, pause, time);

    // body (live text + cursor)
    const body = document.createElement('div');
    body.className = 'entry-body';
    const p = document.createElement('p');
    p.className = 'entry-text';
    const cursor = document.createElement('span');
    cursor.className = 'live-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    body.append(p, cursor);

    // private ghost line (remote PRIVATE state)
    const ghost = document.createElement('div');
    ghost.className = 'ghost-line';
    ghost.append(avatarEl(author, 20));
    const ghostText = document.createElement('span');
    ghostText.textContent = `${author.name} is writing`;
    const dots = document.createElement('span');
    dots.className = 'ghost-dots';
    dots.innerHTML = '<i></i><i></i><i></i>';
    ghost.append(ghostText, dots);

    // foot: privacy caption for the writer's own private draft
    const foot = document.createElement('div');
    foot.className = 'entry-foot';

    el.append(head, body, ghost, foot);
    this._insertSorted(el, draft.startedAt);
    if (animate && !prefersReducedMotion()) el.classList.add('enter');

    const rec = { el, text: draft.text, vis: draft.visibility, chip, cursor, timeEl: time, footEl: foot, cleanup: null };
    this.draftEls.set(draft.id, rec);
    this._applyChip(rec, draft, self);
    this._applyMode(rec, mode, draft);
    if (mode === MODE.GHOST) {
      // privacy: no remote private text in this document — words arrive on reveal
      rec.text = draft.text;
    } else {
      this._setText(p, '', draft.text, rec);
    }
    el.classList.toggle('is-paused', draft.status === 'PAUSED');
    this._stick();
  }

  _updateDraft(draft, ops) {
    const rec = this.draftEls.get(draft.id);
    const mode = this._modeFor(draft);

    if (!rec) {
      if (mode !== MODE.NONE) this._ensureDraft(draft, true);
      return;
    }
    if (mode === MODE.NONE) {
      this._remove(draft.id);
      return;
    }

    const self = draft.authorId === this.session.identity?.id;
    if (rec.vis !== draft.visibility) {
      const wasGhost = rec.el.classList.contains('is-ghost');
      rec.vis = draft.visibility;
      this._applyChip(rec, draft, self);
      this._applyMode(rec, mode, draft);
      if (wasGhost && mode === MODE.TEXT) {
        // revealing the draft: the whole text surfaces as one soft ink pass
        rec.cleanup?.();
        this._setText(rec.el.querySelector('.entry-text'), '', draft.text, rec);
        rec.text = draft.text;
        this._stick();
        return;
      }
    }

    rec.el.classList.toggle('is-paused', draft.status === 'PAUSED');
    rec.timeEl.textContent = fmtTime(draft.updatedAt);

    if (mode === MODE.GHOST) {
      rec.text = draft.text;
      return;
    }

    const p = rec.el.querySelector('.entry-text');
    let from = rec.text;
    let next = from;
    if (ops?.length) {
      try { next = applyOps(from, ops); } catch { next = draft.text; }
    }
    if (next !== draft.text) next = draft.text; // converge on the snapshot

    this._setText(p, from, next, rec);
    rec.text = next;
    this._stick();
  }

  _setPaused(draft, paused) {
    const rec = this.draftEls.get(draft.id);
    if (rec) rec.el.classList.toggle('is-paused', paused);
  }

  _applyChip(rec, draft, self) {
    const chip = rec.chip;
    if (self && draft.visibility === 'PRIVATE') {
      chip.textContent = 'private';
      chip.className = 'chip private';
      rec.footEl.textContent = 'private draft · only you see this';
      rec.footEl.classList.add('reveal');
    } else {
      chip.textContent = 'live draft';
      chip.className = 'chip live';
      if (self) rec.footEl.classList.remove('reveal');
    }
  }

  _applyMode(rec, mode, draft) {
    const el = rec.el;
    if (mode === MODE.GHOST) {
      el.classList.add('is-ghost');
      el.classList.remove('is-paused');
      /* privacy: a remote private draft keeps no text in this document at all;
         the words return via snapshot when the writer goes LIVE again */
      rec.el.querySelector('.entry-text').textContent = '';
      rec.text = draft.text;
    } else {
      el.classList.remove('is-ghost');
    }
  }

  /* The heart of the "living ink": rebuild the paragraph from
     prefix + inserted + ghost(deleted) + suffix, animating only the change. */
  _setText(p, from, to, rec) {
    rec.cleanup?.();
    rec.cleanup = null;

    if (prefersReducedMotion() || from === to) {
      p.textContent = to;
      p.append(rec.cursor);
      return;
    }

    let start = 0;
    const min = Math.min(from.length, to.length);
    while (start < min && from[start] === to[start]) start++;
    let endF = from.length;
    let endT = to.length;
    while (endF > start && endT > start && from[endF - 1] === to[endT - 1]) { endF--; endT--; }

    const pre = to.slice(0, start);
    const inserted = to.slice(start, endT);
    const post = to.slice(endT);
    const deleted = from.slice(start, endF);

    p.textContent = '';
    p.append(document.createTextNode(pre));

    let insertedSpan = null;
    if (inserted) {
      if (inserted.length <= 140) {
        insertedSpan = document.createElement('span');
        insertedSpan.className = 'ink-in';
        insertedSpan.textContent = inserted;
        p.append(insertedSpan);
      } else {
        p.append(document.createTextNode(inserted));
      }
    }

    let ghost = null;
    if (deleted) {
      ghost = document.createElement('span');
      ghost.className = 'ink-out';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.textContent = deleted;
      p.append(ghost);
    }

    p.append(document.createTextNode(post));
    p.append(rec.cursor);

    const pending = [];
    if (insertedSpan) {
      pending.push(() => insertedSpan.replaceWith(document.createTextNode(insertedSpan.textContent)));
    }
    if (ghost) pending.push(() => ghost.remove());
    if (pending.length) {
      rec.cleanup = () => { while (pending.length) pending.pop()(); rec.cleanup = null; };
      insertedSpan?.addEventListener('animationend', rec.cleanup, { once: true });
      // deletions have no animationend guarantee if the node never animates
      setTimeout(() => rec.cleanup?.(), 400);
    }
  }

  /* ---------- transitions ---------- */

  _commit(draft, message) {
    const rec = this.draftEls.get(draft.id);
    this.draftEls.delete(draft.id);
    if (!rec) {
      this._addMessage(message, true);
      return;
    }
    this.msgEls.set(message.id, rec.el);
    const el = rec.el;
    rec.cleanup?.();
    rec.cleanup = null;

    el.classList.remove('is-paused');
    el.classList.add('is-committed');       // dries into the page
    rec.chip.classList.add('fade-out');     // LIVE DRAFT tag dissolves
    rec.cursor.classList.add('cursor-off'); // cursor collapses
    rec.footEl.textContent = this._caption(message);
    rec.footEl.classList.add('reveal');
    setTimeout(() => rec.chip.remove(), 600);
    this._scheduleExpireVisual(el, message);
    this._stick();
  }

  /* ---------- ephemeral dissolve ---------- */

  _caption(message) {
    const base = `sent · ${fmtTime(message.createdAt)}`;
    return message.expiresAt ? `${base} · vanishes` : base;
  }

  _scheduleExpireVisual(el, message) {
    if (!message.expiresAt) return;
    const remain = message.expiresAt - Date.now();
    setTimeout(() => el.classList.add('expiring'), Math.max(0, remain - 2400));
  }

  _expire(message) {
    const el = this.msgEls.get(message.id);
    if (!el) return;
    this.msgEls.delete(message.id);
    this._collapse(el);
  }

  /* Freeze the entry's measured box, then let the dissolve animation close
     it — the page below glides up with no layout jump. */
  _collapse(el) {
    if (!el.isConnected) return;
    el.style.height = `${el.offsetHeight}px`;
    el.style.marginBottom = getComputedStyle(el).marginBottom;
    void el.offsetWidth; // commit the measured box before animating from it
    el.classList.remove('expiring');
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 720);
  }

  _remove(draftId) {
    const rec = this.draftEls.get(draftId);
    if (!rec) return;
    this.draftEls.delete(draftId);
    rec.cleanup?.();
    this._collapse(rec.el);
  }

  /* ---------- helpers ---------- */

  _author(id, snapshot) {
    return this.session.users?.get(id)
      ?? snapshot
      ?? { id, name: id, initial: id[0]?.toUpperCase() ?? '?', bg: '#1a1d24', fg: '#9aa3af', ring: 'rgba(255,255,255,0.2)' };
  }

  _insertSorted(el, key) {
    el.dataset.key = String(key);
    for (const child of this.container.children) {
      if (Number(child.dataset.key) > key) {
        this.container.insertBefore(el, child);
        return;
      }
    }
    this.container.append(el);
  }

  _stick(force) {
    const page = document.getElementById('page');
    if (!page) return;
    const nearBottom = page.scrollHeight - page.scrollTop - page.clientHeight < 140;
    if (force || nearBottom) page.scrollTop = page.scrollHeight;
  }
}
