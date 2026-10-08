import { Router } from "express";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { blockedUserIds } from "../utils/visibility.js";
import { friendIdsOf } from "../utils/friendGraph.js";
import { escapeRegex } from "../utils/regex.js";

// The people offered when someone types @ in what they are writing: friends first, then other people with a public profile whose
// username (or a word of whose name) starts with what was typed. Anyone blocked either way, suspended, or private and not a friend is left out.
export const mentionsRouter = Router();
mentionsRouter.use(requireAuth);

export const MAX_SUGGESTIONS = 8;
const TYPED = /^[A-Za-z0-9_]{1,30}$/;
const limiter = createLimiter({ name: "mention-suggest", limit: 900, windowMs: 60 * 60 * 1000 });

const person = (user, isFriend) => ({ id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null, isFriend });

// GET /api/mentions/suggest?q=sa → { people: [{ username, displayName, avatarUrl, isFriend }] } (nothing typed yet gives your friends)
mentionsRouter.get("/suggest", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().replace(/^@/, "") : "";
  if (q && !TYPED.test(q)) return res.json({ people: [] });
  if (!(await limiter.allow(req.user.id))) return res.status(429).json({ error: "You're searching too fast — try again in a bit" });

  const [friends, blocked] = await Promise.all([friendIdsOf(req.user.id), blockedUserIds(req.user.id)]);
  const starts = q ? new RegExp(`^${escapeRegex(q)}`, "i") : null;
  const named = starts ? { $or: [{ username: starts }, { displayName: new RegExp(`(^|\\s)${escapeRegex(q)}`, "i") }] } : {};
  const notBlocked = { $nin: [...blocked, req.user.id] };

  const mine = await User.find({ ...named, _id: { $in: [...friends].filter((id) => !blocked.has(String(id))) }, suspendedAt: null })
    .sort({ username: 1 })
    .limit(MAX_SUGGESTIONS)
    .select("username displayName avatarUrl");
  const people = mine.map((u) => person(u, true));
  // nothing typed yet means just friends; with something typed, other people fill the rest of the list
  if (starts && people.length < MAX_SUGGESTIONS) {
    const others = await User.find({ ...named, _id: notBlocked, isPrivate: { $ne: true }, suspendedAt: null })
      .sort({ username: 1 })
      .limit(MAX_SUGGESTIONS * 2)
      .select("username displayName avatarUrl");
    const have = new Set(people.map((p) => String(p.id)));
    for (const user of others) {
      if (people.length >= MAX_SUGGESTIONS) break;
      if (!have.has(String(user._id))) people.push(person(user, false));
    }
  }
  res.json({ people });
});
