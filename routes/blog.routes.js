import { Router } from "express";
import mongoose from "mongoose";
import { BlogEntry } from "../models/BlogEntry.js";
import { Friendship } from "../models/Friendship.js";
import { Notification } from "../models/Notification.js";
import { BlogComment } from "../models/BlogComment.js";
import { releasePictures } from "../services/commentPictures.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import { assertVisible, getProfileForViewer } from "../utils/visibility.js";
import { toPublicUser } from "../utils/serialize.js";
import { createLimiter } from "../utils/rateLimit.js";
import { checkEntry, excerptOf } from "../utils/blogText.js";

// Blog / journal entries: longer writing on a profile. Reading follows the profile's own visibility rules exactly.
export const blogRouter = Router();
// Someone's list of entries is read like the rest of their profile (a public profile can be read without signing in), so it comes first;
// everything else about the blog needs a sign-in.
blogRouter.get("/user/:username", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    const page = Math.min(50, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
    const found = await BlogEntry.find({ author: user._id })
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * PAGE)
      .limit(PAGE + 1);
    const entries = found.slice(0, PAGE);
    const counts = new Map((await BlogComment.aggregate([{ $match: { entry: { $in: entries.map((e) => e._id) } } }, { $group: { _id: "$entry", n: { $sum: 1 } } }])).map((c) => [String(c._id), c.n]));
    res.json({ entries: entries.map((e) => summary(e, counts.get(String(e._id)) ?? 0)), page, hasMore: found.length > PAGE });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

blogRouter.use(requireAuth);

const PAGE = 10;
const MAX_ENTRIES_PER_AUTHOR = 200;
const writeLimiter = createLimiter({ name: "blog-write", limit: 10, windowMs: 60 * 60 * 1000 });
const validId = (id) => mongoose.isValidObjectId(id);

const summary = (e, commentCount = 0) => ({ id: e._id, title: e.title, excerpt: excerptOf(e.body), createdAt: e.createdAt, updatedAt: e.updatedAt, commentCount });
const full = async (e, author, viewerId) => ({
  commentCount: await BlogComment.countDocuments({ entry: e._id }),
  id: e._id,
  title: e.title,
  body: e.body,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
  isAuthor: String(author._id) === String(viewerId),
  author: await toPublicUser(author, viewerId),
});

// An entry's author's friends hear about it. A failure here never stops the entry from being saved.
async function notifyFriends(entry, authorId) {
  try {
    const friendships = await Friendship.find({ status: "accepted", $or: [{ requester: authorId }, { addressee: authorId }] });
    const friendIds = friendships.map((f) => (String(f.requester) === String(authorId) ? f.addressee : f.requester));
    if (!friendIds.length) return;
    await Notification.insertMany(friendIds.map((recipient) => ({ recipient, type: "blog_post", payload: { actorId: String(authorId), entryId: String(entry._id), title: entry.title } })));
  } catch (err) {
    console.error("Couldn't notify friends of a blog entry:", err.message);
  }
}

// What an entry sent (the announcement to friends, and the note to its author about each comment), once it is gone.
export const removeBlogNotifications = (entryIds) => Notification.deleteMany({ type: { $in: ["blog_post", "blog_comment"] }, "payload.entryId": { $in: entryIds.map(String) } });

/** An entry is gone: its comments go with it, and their pictures. */
export async function removeBlogComments(entryIds) {
  const withPictures = await BlogComment.find({ entry: { $in: entryIds }, imageUrl: { $ne: null } });
  await BlogComment.deleteMany({ entry: { $in: entryIds } });
  await releasePictures(withPictures);
}

// One entry. If its author's profile isn't visible to you it answers 404, exactly as if the entry did not exist.
blogRouter.get("/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Entry not found" });
  const entry = await BlogEntry.findById(req.params.id).populate("author");
  if (!entry || !entry.author) return res.status(404).json({ error: "Entry not found" });
  try {
    await assertVisible(entry.author, req.user.id);
  } catch {
    return res.status(404).json({ error: "Entry not found" });
  }
  res.json({ entry: await full(entry, entry.author, req.user.id) });
});

blogRouter.post("/", requireVerifiedEmail, async (req, res) => {
  const checked = checkEntry(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if ((await BlogEntry.countDocuments({ author: req.user.id })) >= MAX_ENTRIES_PER_AUTHOR) {
    return res.status(400).json({ error: `You can keep up to ${MAX_ENTRIES_PER_AUTHOR} entries — delete an old one first` });
  }
  if (!(await writeLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(writeLimiter.windowSeconds));
    return res.status(429).json({ error: "You've written a lot of entries — try again later." });
  }
  const entry = await BlogEntry.create({ author: req.user.id, title: checked.title, body: checked.body });
  await notifyFriends(entry, req.user.id);
  await entry.populate("author");
  res.status(201).json({ entry: await full(entry, entry.author, req.user.id) });
});

// Only the author can change an entry; everyone else gets the same 404 as for one that doesn't exist.
blogRouter.put("/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Entry not found" });
  const entry = await BlogEntry.findOne({ _id: req.params.id, author: req.user.id });
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  const checked = checkEntry(req.body, { partial: true });
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!(await writeLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(writeLimiter.windowSeconds));
    return res.status(429).json({ error: "You've changed a lot of entries — try again later." });
  }
  Object.assign(entry, checked);
  await entry.save();
  await entry.populate("author");
  res.json({ entry: await full(entry, entry.author, req.user.id) });
});

blogRouter.delete("/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Entry not found" });
  const entry = await BlogEntry.findOneAndDelete({ _id: req.params.id, author: req.user.id });
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  await removeBlogNotifications([entry._id]);
  await removeBlogComments([entry._id]);
  res.status(204).end();
});
