import { Router } from "express";
import mongoose from "mongoose";
import { Bulletin } from "../models/Bulletin.js";
import { Friendship } from "../models/Friendship.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import { blockedUserIds } from "../utils/visibility.js";
import { toPublicUser } from "../utils/serialize.js";
import { createLimiter } from "../utils/rateLimit.js";
import { cleanLine } from "../utils/profileFields.js";
import { cleanBody } from "../utils/blogText.js";
import { allowEdit } from "../utils/textInput.js";

// Bulletins: a short message to all of your friends at once, on a board only friends can see. They expire.
export const bulletinsRouter = Router();
bulletinsRouter.use(requireAuth);

export const MAX_BULLETIN_TITLE = 80;
export const MAX_BULLETIN_BODY = 500;
const KEEP_MS = 10 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE = 10;
const BOARD_SIZE = 50;
const postLimiter = createLimiter({ name: "bulletin-post", limit: 5, windowMs: 24 * 60 * 60 * 1000 });
const validId = (id) => mongoose.isValidObjectId(id);

async function friendIdsOf(userId) {
  const friendships = await Friendship.find({ status: "accepted", $or: [{ requester: userId }, { addressee: userId }] });
  const blocked = await blockedUserIds(userId);
  return friendships.map((f) => (String(f.requester) === String(userId) ? f.addressee : f.requester)).filter((id) => !blocked.has(String(id)));
}

function checkBulletin(input) {
  if (typeof input?.title !== "string" || !cleanLine(input.title)) return { error: "Give your bulletin a title" };
  const title = cleanLine(input.title);
  if (title.length > MAX_BULLETIN_TITLE) return { error: `Titles can be up to ${MAX_BULLETIN_TITLE} characters` };
  if (typeof input?.body !== "string" || !cleanBody(input.body)) return { error: "Write something in your bulletin" };
  const body = cleanBody(input.body);
  if (body.length > MAX_BULLETIN_BODY) return { error: `Bulletins can be up to ${MAX_BULLETIN_BODY} characters` };
  return { title, body };
}

// What this person may read: their own bulletins and those of their friends, newest first.
bulletinsRouter.get("/", async (req, res) => {
  const friends = await friendIdsOf(req.user.id);
  const found = await Bulletin.find({ author: { $in: [req.user.id, ...friends] }, expireAt: { $gt: new Date() } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(BOARD_SIZE)
    .populate("author");
  res.json({
    bulletins: await Promise.all(
      found
        .filter((b) => b.author)
        .map(async (b) => ({
          id: b._id,
          title: b.title,
          body: b.body,
          createdAt: b.createdAt,
          editedAt: b.editedAt ?? null,
          expiresAt: b.expireAt,
          isMine: String(b.author._id) === String(req.user.id),
          author: await toPublicUser(b.author, req.user.id),
        }))
    ),
  });
});

// How many of your friends' bulletins you haven't looked at yet (for the badge).
bulletinsRouter.get("/unread-count", async (req, res) => {
  const me = await User.findById(req.user.id).select("bulletinsSeenAt");
  const friends = await friendIdsOf(req.user.id);
  const filter = { author: { $in: friends }, expireAt: { $gt: new Date() } };
  if (me?.bulletinsSeenAt) filter.createdAt = { $gt: me.bulletinsSeenAt };
  res.json({ unread: friends.length ? await Bulletin.countDocuments(filter) : 0 });
});

// Looking at the board marks everything on it as seen.
bulletinsRouter.post("/seen", async (req, res) => {
  await User.updateOne({ _id: req.user.id }, { $set: { bulletinsSeenAt: new Date() } });
  res.status(204).end();
});

bulletinsRouter.post("/", requireVerifiedEmail, async (req, res) => {
  const checked = checkBulletin(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if ((await Bulletin.countDocuments({ author: req.user.id, expireAt: { $gt: new Date() } })) >= MAX_ACTIVE) {
    return res.status(400).json({ error: `You can have up to ${MAX_ACTIVE} bulletins up at once — delete one first` });
  }
  if (!(await postLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(postLimiter.windowSeconds));
    return res.status(429).json({ error: "You've posted a lot of bulletins today — try again tomorrow." });
  }
  const bulletin = await Bulletin.create({ author: req.user.id, title: checked.title, body: checked.body, expireAt: new Date(Date.now() + KEEP_MS) });
  await bulletin.populate("author");
  res.status(201).json({
    bulletin: { id: bulletin._id, title: bulletin.title, body: bulletin.body, createdAt: bulletin.createdAt, editedAt: null, expiresAt: bulletin.expireAt, isMine: true, author: await toPublicUser(bulletin.author, req.user.id) },
  });
});

// Change your own bulletin (its ten days don't start again). Marked as edited.
bulletinsRouter.patch("/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Bulletin not found" });
  const bulletin = await Bulletin.findOne({ _id: req.params.id, author: req.user.id, expireAt: { $gt: new Date() } });
  if (!bulletin) return res.status(404).json({ error: "Bulletin not found" });
  const checked = checkBulletin({ title: req.body?.title ?? bulletin.title, body: req.body?.body ?? bulletin.body });
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!(await allowEdit(req, res))) return;
  if (checked.title !== bulletin.title || checked.body !== bulletin.body) {
    bulletin.title = checked.title;
    bulletin.body = checked.body;
    bulletin.editedAt = new Date();
    await bulletin.save();
  }
  await bulletin.populate("author");
  res.json({
    bulletin: { id: bulletin._id, title: bulletin.title, body: bulletin.body, createdAt: bulletin.createdAt, editedAt: bulletin.editedAt, expiresAt: bulletin.expireAt, isMine: true, author: await toPublicUser(bulletin.author, req.user.id) },
  });
});

// Only the author can take one down; anyone else gets the same 404 as for one that isn't there.
bulletinsRouter.delete("/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Bulletin not found" });
  const removed = await Bulletin.findOneAndDelete({ _id: req.params.id, author: req.user.id });
  if (!removed) return res.status(404).json({ error: "Bulletin not found" });
  res.status(204).end();
});
