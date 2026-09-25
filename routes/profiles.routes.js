import { Router } from "express";
import { User } from "../models/User.js";
import { TopFriend } from "../models/TopFriend.js";
import { ProfileComment } from "../models/ProfileComment.js";
import { Track } from "../models/Track.js";
import { Notification } from "../models/Notification.js";
import { requireAuth, attachUserIfPresent, clearAuthCookie, setAuthCookie, signAuthToken } from "../middleware/auth.js";
import { Friendship } from "../models/Friendship.js";
import { UsernameHistory } from "../models/UsernameHistory.js";
import { usernameSchema, displayNameSchema } from "../utils/username.js";
import { createLimiter } from "../utils/rateLimit.js";
import { deleteAccount } from "../services/accountDeletion.js";
import { deleteStoredAssetIfUnused } from "../services/storedAssets.js";
import { toPublicUser, toPublicTrack, toPublicComment } from "../utils/serialize.js";
import { getProfileForViewer } from "../utils/visibility.js";
import { escapeRegex } from "../utils/regex.js";

export const profilesRouter = Router();

profilesRouter.get("/", requireAuth, async (req, res) => {
  const search = req.query.search;
  if (!search) return res.json({ users: [] });
  const pattern = escapeRegex(search);
  const users = await User.find({
    $or: [{ username: { $regex: pattern, $options: "i" } }, { displayName: { $regex: pattern, $options: "i" } }],
  }).limit(20);
  res.json({ users: await Promise.all(users.map((u) => toPublicUser(u, req.user.id))) });
});

profilesRouter.patch("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id);
  const { displayName, bio, avatarUrl, wallpaperUrl, wallpaperType, wallpaperPosition, isPrivate, theme } = req.body;
  if (displayName !== undefined) {
    const parsedName = displayNameSchema.safeParse(displayName);
    if (!parsedName.success) return res.status(400).json({ error: parsedName.error.issues[0].message });
    req.body.displayName = parsedName.data;
  }
  if (bio !== undefined && bio !== null && (typeof bio !== "string" || bio.length > 1000)) {
    return res.status(400).json({ error: "Bio must be text of 1000 characters or fewer" });
  }
  const replaced = [];

  if (displayName !== undefined) user.displayName = req.body.displayName;
  if (bio !== undefined) user.bio = bio;
  if (avatarUrl !== undefined) {
    if (user.avatarUrl && user.avatarUrl !== avatarUrl) replaced.push(user.avatarUrl);
    user.avatarUrl = avatarUrl;
  }
  if (wallpaperUrl !== undefined) {
    if (user.wallpaperUrl && user.wallpaperUrl !== wallpaperUrl) replaced.push(user.wallpaperUrl);
    user.wallpaperUrl = wallpaperUrl;
  }
  if (wallpaperType !== undefined) user.wallpaperType = wallpaperType;
  if (wallpaperPosition !== undefined) user.wallpaperPosition = wallpaperPosition;
  if (isPrivate !== undefined) user.isPrivate = isPrivate;
  if (theme !== undefined) user.theme = { ...(user.theme?.toObject?.() ?? user.theme ?? {}), ...theme };

  await user.save();
  // A replaced avatar/wallpaper we stored (an upload or an AI image) would
  // otherwise stay on Cloudinary forever.
  for (const oldUrl of replaced) await deleteStoredAssetIfUnused({ ownerId: user._id, url: oldUrl });
  res.json({ user: await toPublicUser(user, req.user.id) });
});

// Self-service account deletion. Requires the current password (a stolen
// session alone can't destroy an account) and is throttled like login.
const deleteAttempts = createLimiter({ name: "delete-account", limit: 5, windowMs: 15 * 60 * 1000 });

profilesRouter.delete("/me", requireAuth, async (req, res) => {
  const { password } = req.body ?? {};
  if (typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Enter your password to delete your account" });
  }
  if (await deleteAttempts.isLimited(req.user.id)) {
    return res.status(429).json({ error: "Too many attempts — please wait a few minutes and try again" });
  }
  const user = await User.findById(req.user.id);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  if (!(await user.comparePassword(password))) {
    await deleteAttempts.hit(req.user.id);
    return res.status(403).json({ error: "Incorrect password" });
  }

  await deleteAccount(user._id);
  clearAuthCookie(res);
  res.status(204).end();
});

async function topFriendsFor(ownerId, viewerId) {
  const rows = await TopFriend.find({ owner: ownerId }).sort("position").populate("target");
  return Promise.all(rows.filter((tf) => tf.target).map((tf) => toPublicUser(tf.target, viewerId)));
}

profilesRouter.put("/me/top-friends", requireAuth, async (req, res) => {
  // req.body.usernames must be an array of strings — a string or number here
  // still has .slice() (or neither), so an unvalidated non-array shape
  // reaches .map() below and crashes instead of just being treated as empty.
  const rawUsernames = Array.isArray(req.body.usernames) ? req.body.usernames : [];
  const usernames = rawUsernames.filter((u) => typeof u === "string").slice(0, 8);
  const users = await User.find({ username: { $in: usernames } });
  const byUsername = new Map(users.map((u) => [u.username, u]));

  // Only accepted friends can be top friends.
  const friendships = await Friendship.find({
    status: "accepted",
    $or: [{ requester: req.user.id }, { addressee: req.user.id }],
  });
  const friendIds = new Set(friendships.map((fr) => (String(fr.requester) === req.user.id ? String(fr.addressee) : String(fr.requester))));

  await TopFriend.deleteMany({ owner: req.user.id });
  // Dedupe by resolved target id, not the raw username string — the unique
  // (owner, target) index means the same friend picked twice (a repeated
  // or case-variant username) would otherwise crash insertMany with a
  // duplicate-key error. Re-index position contiguously over what's kept.
  const seenTargets = new Set();
  const docs = [];
  for (const username of usernames) {
    const target = byUsername.get(username);
    if (!target || !friendIds.has(String(target._id)) || seenTargets.has(String(target._id))) continue;
    seenTargets.add(String(target._id));
    docs.push({ owner: req.user.id, target: target._id, position: docs.length });
  }
  if (docs.length) await TopFriend.insertMany(docs);

  res.json({ topFriends: await topFriendsFor(req.user.id, req.user.id) });
});

// Change your username. Usernames are public URLs, so: URL-safe characters only,
// unique (case-insensitively), limited to 3 changes a day, and the name you give up
// stays reserved for you for 30 days so nobody can instantly take it over.
const usernameChanges = createLimiter({ name: "username-change", limit: 3, windowMs: 24 * 60 * 60 * 1000 });

profilesRouter.put("/me/username", requireAuth, async (req, res) => {
  const parsed = usernameSchema.safeParse(req.body?.username);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const wanted = parsed.data.toLowerCase();

  const user = await User.findById(req.user.id);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  if (wanted === user.username) return res.json({ user: await toPublicUser(user, req.user.id) });

  if (await usernameChanges.isLimited(req.user.id)) {
    return res.status(429).json({ error: "You can change your username 3 times a day — try again tomorrow" });
  }
  if (await User.exists({ username: wanted })) {
    return res.status(409).json({ error: "That username is already taken" });
  }
  const reserved = await UsernameHistory.findOne({ username: wanted, user: { $ne: user._id } });
  if (reserved) {
    return res.status(409).json({ error: "That username was recently used by someone else and isn't available yet" });
  }

  const previous = user.username;
  user.username = wanted;
  try {
    await user.save();
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: "That username is already taken" });
    throw err;
  }
  await usernameChanges.hit(req.user.id);
  await UsernameHistory.create({ username: previous, user: user._id, expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
  // The session token carries the username; re-issue it so it's current.
  setAuthCookie(res, signAuthToken(user));
  res.json({ user: await toPublicUser(user, req.user.id) });
});

profilesRouter.delete("/comments/:commentId", requireAuth, async (req, res) => {
  const comment = await ProfileComment.findById(req.params.commentId);
  if (!comment) return res.status(404).json({ error: "Comment not found" });
  const isAuthor = String(comment.author) === req.user.id;
  const isOwner = String(comment.profileOwner) === req.user.id;
  if (!isAuthor && !isOwner) return res.status(403).json({ error: "Not allowed" });
  await comment.deleteOne();
  res.status(204).end();
});

profilesRouter.get("/:username", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    res.json({ user: await toPublicUser(user, req.user?.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

profilesRouter.get("/:username/top-friends", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    res.json({ topFriends: await topFriendsFor(user._id, req.user?.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

profilesRouter.get("/:username/comments", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    const comments = await ProfileComment.find({ profileOwner: user._id })
      .sort("-createdAt")
      .populate("author");
    res.json({ comments: await Promise.all(comments.map((c) => toPublicComment(c, req.user?.id))) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

profilesRouter.post("/:username/comments", requireAuth, async (req, res) => {
  let owner;
  try {
    owner = await getProfileForViewer(req.params.username, req.user.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  let comment = await ProfileComment.create({
    profileOwner: owner._id,
    author: req.user.id,
    content: req.body.content,
  });
  comment = await comment.populate("author");
  if (String(owner._id) !== req.user.id) {
    await Notification.create({
      recipient: owner._id,
      type: "profile_comment",
      payload: { commentId: comment._id, actorId: req.user.id },
    });
  }
  res.status(201).json({ comment: await toPublicComment(comment, req.user.id) });
});

profilesRouter.get("/:username/tracks", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    const tracks = await Track.find({ owner: user._id }).sort("position");
    res.json({ tracks: tracks.map(toPublicTrack) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
