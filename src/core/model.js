/* Domain model factories. Shapes mirror the future server schema:
   LiveDraft { id, conversationId, authorId, text, visibility, updatedAt,
               status, cursorPosition, expiresAt } */

import { DraftStatus, Visibility } from './events.js';

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const ts = () => Date.now();

export function createDraft({ conversationId, authorId, text = '', visibility = Visibility.LIVE }) {
  const now = ts();
  return {
    id: uid(),
    conversationId,
    authorId,
    text,
    visibility,
    updatedAt: now,
    status: DraftStatus.WRITING,
    cursorPosition: text.length,
    /* expiresAt is enforced server-side in the future (stale-draft GC);
       the prototype simply never persists drafts. */
    expiresAt: now + 10 * 60 * 1000,
    startedAt: now,
    rev: 0,
  };
}

export function createMessage({ conversationId, authorId, text, ephemeral = false, ttlMs = 0 }) {
  const createdAt = ts();
  return {
    id: uid(),
    conversationId,
    authorId,
    text,
    createdAt,
    via: 'draft',
    ephemeral,
    /* ephemeral messages dissolve a few seconds after they are received;
       null means the message is permanent page history */
    expiresAt: ephemeral ? createdAt + ttlMs : null,
  };
}

export function draftSnapshot(d) {
  return {
    id: d.id,
    conversationId: d.conversationId,
    authorId: d.authorId,
    text: d.text,
    visibility: d.visibility,
    updatedAt: d.updatedAt,
    status: d.status,
    cursorPosition: d.cursorPosition,
    expiresAt: d.expiresAt,
    startedAt: d.startedAt,
    rev: d.rev,
  };
}
