import { Router } from "express";
import { User } from "../models/User.js";
import { Block } from "../models/Block.js";
import { Friendship } from "../models/Friendship.js";
import { TopFriend } from "../models/TopFriend.js";
import { ProfileComment } from "../models/ProfileComment.js";
import { Track } from "../models/Track.js";
import { Notification } from "../models/Notification.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { toPublicUser } from "../utils/serialize.js";

export const profilesRouter = Router();

async function areBlocked(idA, idB) {
  const block = await Block.findOne({
    $or: [
      { blocker: idA, blocked: idB },
      { blocker: idB, blocked: idA },
    ],
  });
  return !!block;
}

async function areFriends(idA, idB) {
  const friendship = await Friendship.findOne({
    status: "accepted",
    $or: [
      { requester: idA, addressee: idB },
      { requester: idB, addressee: idA },
    ],
  });
  return !!friendship;
}

async function getProfileForViewer(username, viewerId) {
  const user = await User.findOne({ username });
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  if (viewerId && (await areBlocked(viewerId, user._id))) {
    const err = new Error("Profile not available");
    err.status = 403;
    throw err;
  }

  if (user.isPrivate && String(user._id) !== String(viewerId)) {
    const isFriend = viewerId ? await areFriends(viewerId, user._id) : false;
    if (!isFriend) {
      const err = new Error("This profile is private");
      err.status = 403;
      throw err;
    }
  }

  return user;
}

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

profilesRouter.get("/:username/top-friends", async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ error: "User not found" });
  const topFriends = await TopFriend.find({ owner: user._id }).sort("position").populate("target");
  res.json({ topFriends: topFriends.map((tf) => toPublicUser(tf.target)) });
});

profilesRouter.get("/:username/comments", async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ error: "User not found" });
  const comments = await ProfileComment.find({ profileOwner: user._id })
    .sort("-createdAt")
    .populate("author");
  res.json({
    comments: comments.map((c) => ({
      id: c._id,
      content: c.content,
      createdAt: c.createdAt,
      author: toPublicUser(c.author),
    })),
  });
});

profilesRouter.post("/:username/comments", requireAuth, async (req, res) => {
  const owner = await User.findOne({ username: req.params.username });
  if (!owner) return res.status(404).json({ error: "User not found" });
  if (await areBlocked(req.user.id, owner._id)) {
    return res.status(403).json({ error: "Not allowed" });
  }
  const comment = await ProfileComment.create({
    profileOwner: owner._id,
    author: req.user.id,
    content: req.body.content,
  });
  if (String(owner._id) !== req.user.id) {
    await Notification.create({
      recipient: owner._id,
      type: "profile_comment",
      payload: { commentId: comment._id, actorId: req.user.id },
    });
  }
  res.status(201).json({ id: comment._id, content: comment.content, createdAt: comment.createdAt });
});

profilesRouter.get("/:username/tracks", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    const tracks = await Track.find({ owner: user._id }).sort("position");
    res.json({ tracks });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
