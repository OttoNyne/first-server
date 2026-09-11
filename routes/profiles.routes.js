import { Router } from "express";
import { User } from "../models/User.js";
import { TopFriend } from "../models/TopFriend.js";
import { ProfileComment } from "../models/ProfileComment.js";
import { Track } from "../models/Track.js";
import { Notification } from "../models/Notification.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { toPublicUser, toPublicTrack, toPublicComment } from "../utils/serialize.js";
import { getProfileForViewer } from "../utils/visibility.js";

export const profilesRouter = Router();

profilesRouter.get("/", requireAuth, async (req, res) => {
  const search = req.query.search;
  if (!search) return res.json({ users: [] });
  const users = await User.find({
    $or: [
      { username: { $regex: search, $options: "i" } },
      { displayName: { $regex: search, $options: "i" } },
    ],
  }).limit(20);
  res.json({ users: users.map(toPublicUser) });
});

profilesRouter.patch("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id);
  const { displayName, bio, avatarUrl, wallpaperUrl, wallpaperType, wallpaperPosition, isPrivate, theme } = req.body;

  if (displayName !== undefined) user.displayName = displayName;
  if (bio !== undefined) user.bio = bio;
  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
  if (wallpaperUrl !== undefined) user.wallpaperUrl = wallpaperUrl;
  if (wallpaperType !== undefined) user.wallpaperType = wallpaperType;
  if (wallpaperPosition !== undefined) user.wallpaperPosition = wallpaperPosition;
  if (isPrivate !== undefined) user.isPrivate = isPrivate;
  if (theme !== undefined) user.theme = { ...(user.theme?.toObject?.() ?? user.theme ?? {}), ...theme };

  await user.save();
  res.json({ user: toPublicUser(user) });
});

profilesRouter.put("/me/top-friends", requireAuth, async (req, res) => {
  const usernames = (req.body.usernames || []).slice(0, 8);
  const users = await User.find({ username: { $in: usernames } });
  const byUsername = new Map(users.map((u) => [u.username, u]));

  await TopFriend.deleteMany({ owner: req.user.id });
  const docs = usernames
    .map((username, index) => {
      const target = byUsername.get(username);
      return target ? { owner: req.user.id, target: target._id, position: index } : null;
    })
    .filter(Boolean);
  if (docs.length) await TopFriend.insertMany(docs);

  res.status(204).end();
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
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

profilesRouter.get("/:username/top-friends", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    const topFriends = await TopFriend.find({ owner: user._id }).sort("position").populate("target");
    res.json({ topFriends: topFriends.map((tf) => toPublicUser(tf.target)) });
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
    res.json({ comments: comments.map(toPublicComment) });
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
  res.status(201).json({ comment: toPublicComment(comment) });
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
