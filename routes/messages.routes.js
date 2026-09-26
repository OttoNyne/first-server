import { Router } from "express";
import mongoose from "mongoose";
import { Message, MAX_MESSAGE_LENGTH, pairKey } from "../models/Message.js";
import { User } from "../models/User.js";
import { Friendship } from "../models/Friendship.js";
import { requireAuth } from "../middleware/auth.js";
import { areBlocked, areFriends } from "../utils/visibility.js";
import { toPublicUser } from "../utils/serialize.js";
import { createLimiter } from "../utils/rateLimit.js";

// Direct messages are friends-only, which is what keeps them from becoming an
// unsolicited-message channel. The per-user limit stops a friend account from
// being used to flood someone.
const SEND_LIMIT = 60;
const SEND_WINDOW_MS = 10 * 60 * 1000;
const sendLimiter = createLimiter({ name: "message-send", limit: SEND_LIMIT, windowMs: SEND_WINDOW_MS });

const PAGE_SIZE = 50;

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

const toPublicMessage = (m, viewerId) => ({
  id: m._id,
  senderId: m.sender,
  recipientId: m.recipient,
  mine: String(m.sender) === String(viewerId),
  body: m.body,
  readAt: m.readAt,
  createdAt: m.createdAt,
});

// Resolves :username to a friend the caller may message, or sends the error.
async function findFriend(req, res) {
  const other = await User.findOne({ username: req.params.username });
  if (!other) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  if (String(other._id) === req.user.id) {
    res.status(400).json({ error: "You can't message yourself" });
    return null;
  }
  if (await areBlocked(req.user.id, other._id)) {
    res.status(403).json({ error: "Not allowed" });
    return null;
  }
  if (!(await areFriends(req.user.id, other._id))) {
    res.status(403).json({ error: "You can only message your friends" });
    return null;
  }
  return other;
}

messagesRouter.get("/unread-count", async (req, res) => {
  const unread = await Message.countDocuments({ recipient: req.user.id, readAt: null });
  res.json({ unread });
});

// One row per friend: latest message plus how many of theirs are unread.
messagesRouter.get("/conversations", async (req, res) => {
  const me = new mongoose.Types.ObjectId(req.user.id);
  const friendships = await Friendship.find({
    status: "accepted",
    $or: [{ requester: me }, { addressee: me }],
  });
  const friendIds = friendships.map((f) => (String(f.requester) === req.user.id ? f.addressee : f.requester));
  if (friendIds.length === 0) return res.json({ conversations: [] });

  const pairs = friendIds.map((id) => pairKey(req.user.id, id));
  const latest = await Message.aggregate([
    { $match: { pair: { $in: pairs } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$pair", last: { $first: "$$ROOT" } } },
  ]);
  const unread = await Message.aggregate([
    { $match: { recipient: me, readAt: null, pair: { $in: pairs } } },
    { $group: { _id: "$sender", count: { $sum: 1 } } },
  ]);
  const unreadBySender = new Map(unread.map((u) => [String(u._id), u.count]));
  const lastByPair = new Map(latest.map((l) => [l._id, l.last]));

  const users = await User.find({ _id: { $in: friendIds } });
  const conversations = await Promise.all(
    users.map(async (u) => {
      const last = lastByPair.get(pairKey(req.user.id, u._id));
      return {
        user: await toPublicUser(u, req.user.id),
        lastMessage: last ? toPublicMessage(last, req.user.id) : null,
        unread: unreadBySender.get(String(u._id)) ?? 0,
      };
    })
  );
  // Conversations with messages first (newest on top), then friends you haven't written to yet.
  conversations.sort((a, b) => {
    if (a.lastMessage && b.lastMessage) return new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt);
    if (a.lastMessage) return -1;
    if (b.lastMessage) return 1;
    return a.user.displayName.localeCompare(b.user.displayName);
  });
  res.json({ conversations });
});

// The thread with one friend, oldest first. Opening it marks their messages read.
messagesRouter.get("/with/:username", async (req, res) => {
  const other = await findFriend(req, res);
  if (!other) return;

  const filter = { pair: pairKey(req.user.id, other._id) };
  if (typeof req.query.before === "string" && mongoose.isValidObjectId(req.query.before)) {
    filter._id = { $lt: req.query.before };
  }
  const newestFirst = await Message.find(filter).sort({ _id: -1 }).limit(PAGE_SIZE + 1);
  const hasMore = newestFirst.length > PAGE_SIZE;
  const page = newestFirst.slice(0, PAGE_SIZE).reverse();

  await Message.updateMany({ sender: other._id, recipient: req.user.id, readAt: null }, { $set: { readAt: new Date() } });

  res.json({
    user: await toPublicUser(other, req.user.id),
    messages: page.map((m) => toPublicMessage(m, req.user.id)),
    hasMore,
  });
});

messagesRouter.post("/with/:username", async (req, res) => {
  const other = await findFriend(req, res);
  if (!other) return;

  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) return res.status(400).json({ error: "Write something to send" });
  if (body.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Messages can be up to ${MAX_MESSAGE_LENGTH} characters` });
  }
  if (!(await sendLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(sendLimiter.windowSeconds));
    return res.status(429).json({ error: "You're sending messages too fast — try again in a few minutes." });
  }

  const message = await Message.create({
    sender: req.user.id,
    recipient: other._id,
    pair: pairKey(req.user.id, other._id),
    body,
  });
  res.status(201).json({ message: toPublicMessage(message, req.user.id) });
});

// Only the sender can delete a message, and it disappears for both people.
messagesRouter.delete("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Message not found" });
  const message = await Message.findById(req.params.id);
  if (!message || String(message.sender) !== req.user.id) return res.status(404).json({ error: "Message not found" });
  await message.deleteOne();
  res.status(204).end();
});
