/* Incremental text diff.
   Produces a minimal retain/delete/insert/retain op list between two strings,
   so keystrokes sync as "INSERT: ' tomorrow'" / "DELETE: 8" instead of
   re-sending the whole draft. */

export function diffOps(a, b) {
  if (a === b) return [];
  const al = a.length;
  const bl = b.length;
  const maxStart = Math.min(al, bl);

  let start = 0;
  while (start < maxStart && a[start] === b[start]) start++;

  let endA = al;
  let endB = bl;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops = [];
  if (start > 0) ops.push({ t: '=', n: start });
  const deleted = endA - start;
  const inserted = b.slice(start, endB);
  if (deleted > 0) ops.push({ t: '-', n: deleted });
  if (inserted.length > 0) ops.push({ t: '+', s: inserted });
  const tail = al - endA;
  if (tail > 0) ops.push({ t: '=', n: tail });
  return ops;
}

export function applyOps(text, ops) {
  let out = '';
  let idx = 0;
  for (const op of ops) {
    if (op.t === '=') {
      out += text.slice(idx, idx + op.n);
      idx += op.n;
    } else if (op.t === '-') {
      idx += op.n;
    } else if (op.t === '+') {
      out += op.s;
    }
  }
  return out + text.slice(idx);
}
