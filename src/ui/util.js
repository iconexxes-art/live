export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtRel(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return 'just now';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)}m ago`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}h ago`;
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
