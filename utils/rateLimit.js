// Per-user sliding-window limiter. In-memory, so it's per-instance and resets
// on restart — fine for a single free-tier instance, and it only ever errs
// toward allowing a few extra actions. Returns true if the action is allowed
// (and records it), false if `key` is over the limit.
export function createLimiter({ limit, windowMs }) {
  const usage = new Map();
  return function allow(key) {
    const now = Date.now();
    const recent = (usage.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      usage.set(key, recent);
      return false;
    }
    recent.push(now);
    usage.set(key, recent);
    return true;
  };
}
