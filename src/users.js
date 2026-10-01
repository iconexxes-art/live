/* Identity primitives: accent palette + conversation id helpers.
   Accounts themselves live in core/auth.js. */

export const ACCENTS = {
  cyan:   { bg: '#10333c', fg: '#8fe3ff', ring: 'rgba(89,210,255,0.35)' },
  violet: { bg: '#282142', fg: '#cfc2ff', ring: 'rgba(160,140,255,0.35)' },
  amber:  { bg: '#3a2c14', fg: '#f2ce8a', ring: 'rgba(227,192,120,0.35)' },
  rose:   { bg: '#3a1620', fg: '#f2a0b8', ring: 'rgba(242,160,184,0.35)' },
  slate:  { bg: '#1c2027', fg: '#c3cad4', ring: 'rgba(255,255,255,0.22)' },
};

/* Direct conversation between two users — order-independent. */
export function dmId(a, b) {
  return `dm:${[a, b].sort().join(':')}`;
}

export function partnerOf(conversationId, myId) {
  const parts = String(conversationId).split(':');
  return parts.find((p, i) => i > 0 && p && p !== myId) ?? null;
}
