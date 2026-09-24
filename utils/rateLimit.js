import { RateLimitHit } from "../models/RateLimitHit.js";

// Sliding-window limiter backed by MongoDB (see models/RateLimitHit.js), so
// limits are durable across restarts and shared across instances.
//
//   isLimited(key) - is `key` at/over the limit right now? (does not count)
//   hit(key)       - record one action for `key`
//   allow(key)     - isLimited + hit in one step; true if the action may proceed
//
// Separate isLimited/hit exist so login can count only *failed* attempts.
// The limiter fails open: if the database call itself errors, the action is
// allowed (and the error logged) rather than locking everyone out.
export function createLimiter({ name, limit, windowMs }) {
  const scoped = (key) => `${name}:${key}`;

  async function isLimited(key) {
    try {
      const since = new Date(Date.now() - windowMs);
      const count = await RateLimitHit.countDocuments({ key: scoped(key), at: { $gt: since } });
      return count >= limit;
    } catch (err) {
      console.error(`Rate limiter (${name}) check failed, allowing:`, err.message);
      return false;
    }
  }

  async function hit(key) {
    try {
      const now = Date.now();
      await RateLimitHit.create({ key: scoped(key), at: new Date(now), expireAt: new Date(now + windowMs) });
    } catch (err) {
      console.error(`Rate limiter (${name}) record failed:`, err.message);
    }
  }

  async function allow(key) {
    if (await isLimited(key)) return false;
    await hit(key);
    return true;
  }

  return { isLimited, hit, allow, windowSeconds: Math.ceil(windowMs / 1000) };
}
