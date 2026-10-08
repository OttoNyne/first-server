import { Router } from "express";
import mongoose from "mongoose";
import { Credit } from "../models/Credit.js";
import { MediaItem } from "../models/MediaItem.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { areBlocked, areFriends, assertVisible, blockedUserIds, getProfileForViewer } from "../utils/visibility.js";
import { cleanLine } from "../utils/profileFields.js";
import { createLimiter } from "../utils/rateLimit.js";
import { toPublicMediaItem } from "../utils/serialize.js";

// Credits on portfolio pieces: the owner says a friend worked on a piece (and in what role); it shows on the piece, and on the friend's
// profile as a collaboration, once the friend accepts. Either of them can take it off again at any time.
export const creditsRouter = Router();

export const MAX_ROLE = 40;
export const MAX_CREDITS_PER_PIECE = 10;
const creditLimit = createLimiter({ name: "credit", limit: 40, windowMs: 60 * 60 * 1000 });
const validId = (id) => mongoose.isValidObjectId(id);
const bad = (res, error, status = 400) => res.status(status).json({ error });

/** A role as stored: one line of plain text, 1 to 40 characters. Returns { value } or { error }. */
export function checkRole(input) {
  if (typeof input !== "string" || !cleanLine(input)) return { error: "Say what they did on it" };
  const value = cleanLine(input);
  if ([...value].length > MAX_ROLE) return { error: `Roles can be up to ${MAX_ROLE} characters` };
  return { value };
}

const person = (user) => ({ id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null, csVerified: Boolean(user.csVerifiedByAdmin || user.csVerifiedEarned) });
const serializeCredit = (credit, user) => ({ id: credit._id, itemId: credit.item, role: credit.role, status: credit.status, user: person(user) });

/**
 * The credits on some pieces, for one viewer: accepted ones for everybody who can see the piece, and the ones still waiting only for the
 * owner (who asked) and the person asked. Anyone the viewer has blocked, or been blocked by, is left out. Returns Map(itemId -> credits).
 */
export async function creditsForItems(itemIds, viewerId) {
  const out = new Map();
  if (!itemIds.length) return out;
  const credits = await Credit.find({ item: { $in: itemIds } }).sort({ createdAt: 1 });
  if (!credits.length) return out;
  const [users, blocked] = await Promise.all([User.find({ _id: { $in: credits.map((c) => c.person) } }).select("username displayName avatarUrl csVerifiedByAdmin csVerifiedEarned suspendedAt"), viewerId ? blockedUserIds(viewerId) : new Set()]);
  const byId = new Map(users.map((u) => [String(u._id), u]));
  for (const credit of credits) {
    const user = byId.get(String(credit.person));
    if (!user || user.suspendedAt || blocked.has(String(credit.person))) continue;
    const mine = viewerId && (String(credit.owner) === String(viewerId) || String(credit.person) === String(viewerId));
    if (credit.status !== "accepted" && !mine) continue;
    out.set(String(credit.item), [...(out.get(String(credit.item)) ?? []), serializeCredit(credit, user)]);
  }
  return out;
}

const forgetNotices = (creditId) => Notification.deleteMany({ type: "credit_request", "payload.creditId": String(creditId) }).catch(() => {});

// Credit a friend on one of your pieces: `{ username, role }`. They are asked, and it counts once they accept.
creditsRouter.post("/for/:itemId", requireAuth, async (req, res) => {
  if (!validId(req.params.itemId)) return bad(res, "Media item not found", 404);
  const item = await MediaItem.findOne({ _id: req.params.itemId, owner: req.user.id });
  if (!item) return bad(res, "Media item not found", 404);
  const role = checkRole(req.body?.role);
  if (role.error) return bad(res, role.error);
  if (typeof req.body?.username !== "string" || !req.body.username.trim()) return bad(res, "Choose who to credit");
  const friend = await User.findOne({ username: req.body.username.trim().toLowerCase() });
  if (!friend || friend.suspendedAt) return bad(res, "No one has that username", 404);
  if (String(friend._id) === String(req.user.id)) return bad(res, "You can't credit yourself");
  if ((await areBlocked(req.user.id, friend._id)) || !(await areFriends(req.user.id, friend._id))) return bad(res, "You can only credit your friends");
  if ((await Credit.countDocuments({ item: item._id })) >= MAX_CREDITS_PER_PIECE) return bad(res, `A piece can credit up to ${MAX_CREDITS_PER_PIECE} people`);
  if (await Credit.exists({ item: item._id, person: friend._id })) return bad(res, "They are already credited on this piece", 409);
  if (!(await creditLimit.allow(req.user.id))) return bad(res, "You've credited a lot of people — try again later.", 429);

  const credit = await Credit.create({ item: item._id, owner: req.user.id, person: friend._id, role: role.value });
  await Notification.create({ recipient: friend._id, type: "credit_request", payload: { actorId: req.user.id, itemId: String(item._id), creditId: String(credit._id), role: role.value } });
  res.status(201).json({ credit: serializeCredit(credit, friend) });
});

// The credits waiting for you to accept, newest first, each with the piece (and who owns it).
creditsRouter.get("/mine", requireAuth, async (req, res) => {
  const credits = await Credit.find({ person: req.user.id, status: "pending" }).sort("-createdAt").limit(50);
  const [items, owners, blocked] = await Promise.all([
    MediaItem.find({ _id: { $in: credits.map((c) => c.item) } }),
    User.find({ _id: { $in: credits.map((c) => c.owner) } }).select("username displayName avatarUrl csVerifiedByAdmin csVerifiedEarned suspendedAt"),
    blockedUserIds(req.user.id),
  ]);
  const itemOf = new Map(items.map((i) => [String(i._id), i]));
  const ownerOf = new Map(owners.map((u) => [String(u._id), u]));
  const requests = credits
    .filter((c) => itemOf.has(String(c.item)) && ownerOf.has(String(c.owner)) && !ownerOf.get(String(c.owner)).suspendedAt && !blocked.has(String(c.owner)))
    .map((c) => ({ id: c._id, role: c.role, item: toPublicMediaItem(itemOf.get(String(c.item))), owner: person(ownerOf.get(String(c.owner))), createdAt: c.createdAt }));
  res.json({ requests });
});

// The pieces other people made that this person is credited on (accepted ones only), as far as the viewer is allowed to see them.
creditsRouter.get("/user/:username", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    const credits = await Credit.find({ person: user._id, status: "accepted" }).sort("-createdAt").limit(100);
    const [items, owners] = await Promise.all([MediaItem.find({ _id: { $in: credits.map((c) => c.item) } }), User.find({ _id: { $in: credits.map((c) => c.owner) } })]);
    const itemOf = new Map(items.map((i) => [String(i._id), i]));
    const collaborations = [];
    for (const owner of owners) {
      try {
        await assertVisible(owner, req.user?.id); // a private profile, or one that blocked the viewer, shows nothing
      } catch {
        continue;
      }
      for (const credit of credits.filter((c) => String(c.owner) === String(owner._id) && itemOf.has(String(c.item)))) {
        collaborations.push({ id: credit._id, role: credit.role, item: toPublicMediaItem(itemOf.get(String(credit.item))), owner: person(owner), createdAt: credit.createdAt });
      }
    }
    collaborations.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ collaborations });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Say yes to a credit you were asked for. The owner is told.
creditsRouter.post("/:id/accept", requireAuth, async (req, res) => {
  if (!validId(req.params.id)) return bad(res, "Credit not found", 404);
  const credit = await Credit.findOne({ _id: req.params.id, person: req.user.id });
  if (!credit) return bad(res, "Credit not found", 404);
  if (credit.status === "pending") {
    credit.status = "accepted";
    await credit.save();
    await forgetNotices(credit._id);
    await Notification.create({ recipient: credit.owner, type: "credit_accepted", payload: { actorId: req.user.id, itemId: String(credit.item), creditId: String(credit._id), role: credit.role } });
  }
  res.json({ credit: { id: credit._id, itemId: credit.item, role: credit.role, status: credit.status } });
});

// Take a credit off: the owner removes it from the piece, or the person credited says no (or no longer wants to be named). Nobody is told.
creditsRouter.delete("/:id", requireAuth, async (req, res) => {
  if (!validId(req.params.id)) return bad(res, "Credit not found", 404);
  const credit = await Credit.findOne({ _id: req.params.id, $or: [{ owner: req.user.id }, { person: req.user.id }] });
  if (!credit) return bad(res, "Credit not found", 404);
  await credit.deleteOne();
  await forgetNotices(credit._id);
  res.status(204).end();
});
