/* Event taxonomy for the LIVE sync protocol.
   The wire format is draft-scoped and incremental: events carry author/draft
   identity plus character-level ops, never a whole conversation. */

export const Events = Object.freeze({
  DRAFT_STARTED:   'draft.started',
  DRAFT_UPDATED:   'draft.updated',
  DRAFT_DELETED:   'draft.deleted',   // author wiped draft text (alias of discard in Phase 1)
  DRAFT_PAUSED:    'draft.paused',
  DRAFT_SENT:      'draft.sent',
  DRAFT_DISCARDED: 'draft.discarded',
  MESSAGE_EXPIRED: 'message.expired',
  USER_JOINED:     'user.joined',
  USER_LEFT:       'user.left',
  PRESENCE_PING:   'presence.ping',
  DRAFT_RESYNC:    'draft.resync',
  E2EE_SESSION_INIT: 'e2ee.session.init',    // internal: request a full snapshot for a missed draft
});

export const DraftStatus = Object.freeze({
  WRITING:   'WRITING',
  PAUSED:    'PAUSED',
  SENT:      'SENT',
  DISCARDED: 'DISCARDED',
});

export const Visibility = Object.freeze({
  LIVE:    'LIVE',    // everyone sees the words as they are written
  PRIVATE: 'PRIVATE', // only the writer sees the draft; others see "X is writing…"
  OFF:     'OFF',     // nothing is shared
});

/* Minimal pub/sub bus. Session state changes are announced here; the UI and
   transport layers subscribe. A future server transport plugs in behind the
   same events. */
export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[live] handler for ${type} failed`, err); }
    }
  }
}
