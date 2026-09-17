// Escapes regex metacharacters so user input can be safely interpolated into
// a MongoDB $regex filter as a literal substring match. Without this, a
// crafted search string is executed as a real regex against every document
// (NoSQL injection into $regex) — e.g. `.*` turns "search for x" into "match
// anything", and a pathological pattern like `(a+)+$` can trigger
// catastrophic backtracking (ReDoS) against the database.
export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
