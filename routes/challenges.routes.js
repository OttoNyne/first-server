import { Router } from "express";
import mongoose from "mongoose";
import { ChallengeEntry } from "../models/ChallengeEntry.js";
import { MediaItem } from "../models/MediaItem.js";
import { User } from "../models/User.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { blockedUserIds } from "../utils/visibility.js";
import { createLimiter } from "../utils/rateLimit.js";
import { summarise } from "../utils/reactions.js";
import { toPublicMediaItem } from "../utils/serialize.js";
import { isLanguage } from "../utils/languages.js";
import { previousWeek, promptFor, weekFromKey, weekOf } from "../utils/challenges.js";

// The weekly creative challenge: one prompt a week for everyone, and people enter a piece from their portfolio. The gallery is public (so
// someone who isn't signed in can see what people made), which is why only public profiles can take part and be shown.
export const challengesRouter = Router();

export const PAGE_SIZE = 24;
const MAX_ENTRIES_READ = 500;
const entryLimit = createLimiter({ name: "challengeEntry", limit: 30, windowMs: 60 * 60 * 1000 });
const bad = (res, error, status = 400) => res.status(status).json({ error });

const person = (user) => ({ id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null, csVerified: Boolean(user.csVerifiedByAdmin || user.csVerifiedEarned) });
const describe = (week, language) => ({ key: week.key, startsAt: week.start, endsAt: week.end, prompt: promptFor(week, language) });
const languageOf = (req) => (isLanguage(req.query.lang) ? req.query.lang : "en");

/** A week's entries that this viewer may be shown (public, not suspended, not blocked either way), with the piece and who made it. */
async function entriesOf(week, viewerId) {
  const entries = await ChallengeEntry.find({ week }).sort({ createdAt: -1 }).limit(MAX_ENTRIES_READ);
  if (!entries.length) return [];
  const [users, items, blocked] = await Promise.all([
    User.find({ _id: { $in: entries.map((e) => e.user) } }).select("username displayName avatarUrl csVerifiedByAdmin csVerifiedEarned isPrivate suspendedAt"),
    MediaItem.find({ _id: { $in: entries.map((e) => e.item) } }),
    viewerId ? blockedUserIds(viewerId) : new Set(),
  ]);
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const itemOf = new Map(items.map((i) => [String(i._id), i]));
  const shown = entries.filter((e) => {
    const user = userOf.get(String(e.user));
    return user && !user.isPrivate && !user.suspendedAt && !blocked.has(String(e.user)) && itemOf.has(String(e.item));
  });
  const summary = await summarise("media", shown.map((e) => e.item), viewerId);
  return shown.map((e) => ({
    id: e._id,
    item: toPublicMediaItem(itemOf.get(String(e.item)), { reactions: summary.get(String(e.item)) }),
    owner: person(userOf.get(String(e.user))),
    createdAt: e.createdAt,
  }));
}

// This week's prompt, last week's, how many have entered, and (signed in) your own entry.
challengesRouter.get("/current", attachUserIfPresent, async (req, res) => {
  const language = languageOf(req);
  const week = weekOf();
  const [entryCount, mine] = await Promise.all([ChallengeEntry.countDocuments({ week: week.key }), req.user ? ChallengeEntry.findOne({ week: week.key, user: req.user.id }) : null]);
  const piece = mine ? await MediaItem.findById(mine.item) : null;
  res.json({
    week: describe(week, language),
    previous: describe(previousWeek(), language),
    entryCount,
    mine: mine && piece ? { id: mine._id, item: toPublicMediaItem(piece) } : null,
  });
});

// A week's entries: `?sort=top` (most reactions first) or newest first, `?page=` for more, `?limit=` for a short list (1–24).
challengesRouter.get("/:week/entries", attachUserIfPresent, async (req, res) => {
  const week = weekFromKey(req.params.week);
  if (!week || week.start > new Date()) return bad(res, "Challenge not found", 404);
  const all = await entriesOf(week.key, req.user?.id);
  if (req.query.sort === "top") all.sort((a, b) => b.item.reactions.total - a.item.reactions.total || new Date(b.createdAt) - new Date(a.createdAt));
  const size = Math.min(PAGE_SIZE, Math.max(1, Number.parseInt(req.query.limit, 10) || PAGE_SIZE));
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const entries = all.slice((page - 1) * size, page * size);
  res.json({ week: describe(week, languageOf(req)), entries, total: all.length, hasMore: page * size < all.length });
});

// Enter one of your pieces in this week's challenge: `{ itemId }`. One entry a week; withdraw it first to enter a different piece.
challengesRouter.post("/current/entry", requireAuth, async (req, res) => {
  const itemId = req.body?.itemId;
  if (typeof itemId !== "string" || !mongoose.isValidObjectId(itemId)) return bad(res, "Choose a piece from your portfolio");
  const item = await MediaItem.findOne({ _id: itemId, owner: req.user.id });
  if (!item) return bad(res, "Choose a piece from your portfolio", 404);
  const me = await User.findById(req.user.id).select("isPrivate");
  if (me?.isPrivate) return bad(res, "Make your profile public to take part — the gallery is open to everyone", 403);
  if (!(await entryLimit.allow(req.user.id))) return bad(res, "You've done that a lot — try again later.", 429);
  const week = weekOf();
  try {
    const entry = await ChallengeEntry.create({ week: week.key, user: req.user.id, item: item._id });
    res.status(201).json({ entry: { id: entry._id, item: toPublicMediaItem(item) } });
  } catch (err) {
    if (err?.code === 11000) return bad(res, "You've already entered this week's challenge", 409);
    throw err;
  }
});

// Take your entry out of this week's challenge.
challengesRouter.delete("/current/entry", requireAuth, async (req, res) => {
  if (!(await entryLimit.allow(req.user.id))) return bad(res, "You've done that a lot — try again later.", 429);
  const entry = await ChallengeEntry.findOneAndDelete({ week: weekOf().key, user: req.user.id });
  if (!entry) return bad(res, "You haven't entered this week's challenge", 404);
  res.status(204).end();
});
