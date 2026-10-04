import { Router } from "express";
import mongoose from "mongoose";
import { Group } from "../models/Group.js";
import { GroupMembership } from "../models/GroupMembership.js";
import { GroupMessage, MAX_GROUP_MESSAGE_LENGTH } from "../models/GroupMessage.js";
import { User } from "../models/User.js";
import { createLimiter } from "../utils/rateLimit.js";
import { blockedUserIds } from "../utils/visibility.js";
import { requireAuth } from "../middleware/auth.js";
import { toPublicUser } from "../utils/serialize.js";
import { escapeRegex } from "../utils/regex.js";

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

async function withMemberInfo(groups, viewerId) {
  const counts = await GroupMembership.aggregate([
    { $match: { group: { $in: groups.map((g) => g._id) } } },
    { $group: { _id: "$group", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

  const memberships = await GroupMembership.find({
    group: { $in: groups.map((g) => g._id) },
    user: viewerId,
  });
  const memberSet = new Set(memberships.map((m) => String(m.group)));
  const roleOf = new Map(memberships.map((m) => [String(m.group), m.role]));

  return groups.map((g) => ({
    id: g._id,
    name: g.name,
    description: g.description,
    bannerUrl: g.bannerUrl,
    createdById: g.createdBy,
    createdAt: g.createdAt,
    memberCount: countMap.get(String(g._id)) || 0,
    isMember: memberSet.has(String(g._id)),
    myRole: roleOf.get(String(g._id)) ?? null,
  }));
}

groupsRouter.get("/", async (req, res) => {
  const filter = req.query.search ? { name: { $regex: escapeRegex(req.query.search), $options: "i" } } : {};
  // Newest first, twenty a page.
  const page = Math.min(100, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const found = await Group.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 20).limit(21);
  res.json({ groups: await withMemberInfo(found.slice(0, 20), req.user.id), page, hasMore: found.length > 20 });
});

groupsRouter.post("/", async (req, res) => {
  const group = await Group.create({
    name: req.body.name,
    description: req.body.description,
    bannerUrl: req.body.bannerUrl,
    createdBy: req.user.id,
  });
  await GroupMembership.create({ group: group._id, user: req.user.id, role: "admin" });
  const [withInfo] = await withMemberInfo([group], req.user.id);
  res.status(201).json({ group: withInfo });
});

groupsRouter.get("/:id", async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const [withInfo] = await withMemberInfo([group], req.user.id);
  res.json({ group: withInfo });
});

groupsRouter.post("/:id/join", async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const existing = await GroupMembership.findOne({ group: group._id, user: req.user.id });
  if (existing) return res.status(409).json({ error: "Already a member" });
  await GroupMembership.create({ group: group._id, user: req.user.id, role: "member" });
  res.status(204).end();
});

groupsRouter.post("/:id/leave", async (req, res) => {
  await GroupMembership.deleteOne({ group: req.params.id, user: req.user.id });
  res.status(204).end();
});

groupsRouter.get("/:id/members", async (req, res) => {
  // Oldest members first, fifty a page.
  const page = Math.min(1000, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const found = await GroupMembership.find({ group: req.params.id }).sort({ joinedAt: 1, _id: 1 }).skip((page - 1) * 50).limit(51).populate("user");
  const members = found.slice(0, 50);
  res.json({
    page,
    hasMore: found.length > 50,
    members: await Promise.all(
      members.map(async (m) => ({
        role: m.role,
        joinedAt: m.joinedAt,
        user: await toPublicUser(m.user, req.user.id),
      }))
    ),
  });
});

// ---- Group chat -----------------------------------------------------------
// Members only: reading and writing both require membership, so leaving a
// group ends access. People you've blocked (or who blocked you) are left out
// of what you see, the same as everywhere else in the app.
const GROUP_CHAT_PAGE = 50;
const groupChatLimiter = createLimiter({ name: "group-chat", limit: 60, windowMs: 10 * 60 * 1000 });

async function requireMembership(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "Group not found" });
    return null;
  }
  const membership = await GroupMembership.findOne({ group: req.params.id, user: req.user.id });
  if (!membership) {
    // 404 for a group that doesn't exist, 403 for one you haven't joined
    const exists = await Group.exists({ _id: req.params.id });
    res.status(exists ? 403 : 404).json({ error: exists ? "Join this group to use its chat" : "Group not found" });
    return null;
  }
  return membership;
}

async function toGroupMessages(messages, viewerId) {
  const senders = await User.find({ _id: { $in: [...new Set(messages.map((m) => String(m.sender)))] } });
  const byId = new Map(senders.map((u) => [String(u._id), u]));
  const publicById = new Map();
  for (const [id, u] of byId) publicById.set(id, await toPublicUser(u, viewerId));
  return messages.map((m) => ({
    id: m._id,
    groupId: m.group,
    senderId: m.sender,
    sender: publicById.get(String(m.sender)) ?? null,
    mine: String(m.sender) === String(viewerId),
    body: m.body,
    createdAt: m.createdAt,
  }));
}

groupsRouter.get("/:id/messages", async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  const blocked = await blockedUserIds(req.user.id);
  const filter = { group: req.params.id, sender: { $nin: [...blocked] } };
  if (typeof req.query.before === "string" && mongoose.isValidObjectId(req.query.before)) {
    filter._id = { $lt: req.query.before };
  }
  const newestFirst = await GroupMessage.find(filter).sort({ _id: -1 }).limit(GROUP_CHAT_PAGE + 1);
  const hasMore = newestFirst.length > GROUP_CHAT_PAGE;
  const page = newestFirst.slice(0, GROUP_CHAT_PAGE).reverse();
  res.json({ messages: await toGroupMessages(page, req.user.id), hasMore });
});

groupsRouter.post("/:id/messages", async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) return res.status(400).json({ error: "Write something to send" });
  if (body.length > MAX_GROUP_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Messages can be up to ${MAX_GROUP_MESSAGE_LENGTH} characters` });
  }
  if (!(await groupChatLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(groupChatLimiter.windowSeconds));
    return res.status(429).json({ error: "You're sending messages too fast — try again in a few minutes." });
  }
  const message = await GroupMessage.create({ group: req.params.id, sender: req.user.id, body });
  const [out] = await toGroupMessages([message], req.user.id);
  res.status(201).json({ message: out });
});

// The sender, or an admin of the group, can remove a message (for everyone).
groupsRouter.delete("/:id/messages/:messageId", async (req, res) => {
  const membership = await requireMembership(req, res);
  if (!membership) return;
  if (!mongoose.isValidObjectId(req.params.messageId)) return res.status(404).json({ error: "Message not found" });
  const message = await GroupMessage.findOne({ _id: req.params.messageId, group: req.params.id });
  const allowed = message && (String(message.sender) === req.user.id || membership.role === "admin");
  if (!allowed) return res.status(404).json({ error: "Message not found" });
  await message.deleteOne();
  res.status(204).end();
});
