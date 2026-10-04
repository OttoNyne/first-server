import { Router } from "express";
import mongoose from "mongoose";
import { Group } from "../models/Group.js";
import { GroupMembership } from "../models/GroupMembership.js";
import { GroupTopic, MAX_TOPIC_BODY, MAX_TOPIC_TITLE } from "../models/GroupTopic.js";
import { GroupReply, MAX_REPLY_BODY } from "../models/GroupReply.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { blockedUserIds } from "../utils/visibility.js";
import { toPublicUser } from "../utils/serialize.js";
import { createLimiter } from "../utils/rateLimit.js";
import { cleanLine } from "../utils/profileFields.js";
import { cleanBody } from "../utils/blogText.js";
import { allowEdit } from "../utils/textInput.js";

// A group's board: lasting topics with replies, for the group's members only (reading and writing both need membership, so leaving a
// group ends access). Authors and group admins can remove things; admins can pin a few topics. People you've blocked, or who blocked
// you, are left out of what you see, as everywhere else.
export const groupBoardRouter = Router();
groupBoardRouter.use(requireAuth);

export const TOPICS_PER_PAGE = 20;
export const REPLIES_PER_PAGE = 50;
export const MAX_PINNED = 3;
const topicLimiter = createLimiter({ name: "group-topic", limit: 10, windowMs: 60 * 60 * 1000 });
const replyLimiter = createLimiter({ name: "group-reply", limit: 30, windowMs: 10 * 60 * 1000 });
const validId = (id) => mongoose.isValidObjectId(id);

// The viewer's membership, or an answer: 404 for a group that doesn't exist, 403 for one they haven't joined.
async function requireMember(req, res) {
  if (!validId(req.params.id)) {
    res.status(404).json({ error: "Group not found" });
    return null;
  }
  const membership = await GroupMembership.findOne({ group: req.params.id, user: req.user.id });
  if (!membership) {
    const exists = await Group.exists({ _id: req.params.id });
    res.status(exists ? 403 : 404).json({ error: exists ? "Join this group to use its board" : "Group not found" });
    return null;
  }
  return membership;
}

async function publicAuthors(docs, viewerId) {
  const ids = [...new Set(docs.map((d) => String(d.author)))];
  const users = await User.find({ _id: { $in: ids } });
  const out = new Map();
  for (const u of users) out.set(String(u._id), await toPublicUser(u, viewerId));
  return out;
}

const topicShape = (t, authors, viewerId) => ({
  id: t._id,
  groupId: t.group,
  title: t.title,
  body: t.body,
  pinned: t.pinned,
  replyCount: t.replyCount,
  createdAt: t.createdAt,
  editedAt: t.editedAt ?? null,
  lastActivityAt: t.lastActivityAt,
  mine: String(t.author) === String(viewerId),
  author: authors.get(String(t.author)) ?? null,
});
const replyShape = (r, authors, viewerId) => ({
  id: r._id,
  topicId: r.topic,
  body: r.body,
  createdAt: r.createdAt,
  editedAt: r.editedAt ?? null,
  mine: String(r.author) === String(viewerId),
  author: authors.get(String(r.author)) ?? null,
});

function checkTopic(input) {
  if (typeof input?.title !== "string" || !cleanLine(input.title)) return { error: "Give your topic a title" };
  const title = cleanLine(input.title);
  if (title.length > MAX_TOPIC_TITLE) return { error: `Titles can be up to ${MAX_TOPIC_TITLE} characters` };
  if (typeof input?.body !== "string" || !cleanBody(input.body)) return { error: "Write something to start the topic" };
  const body = cleanBody(input.body);
  if (body.length > MAX_TOPIC_BODY) return { error: `Topics can be up to ${MAX_TOPIC_BODY} characters` };
  return { title, body };
}

// The topics: pinned first, then the most recently active, twenty a page.
groupBoardRouter.get("/:id/topics", async (req, res) => {
  if (!(await requireMember(req, res))) return;
  const page = Math.min(50, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const blocked = await blockedUserIds(req.user.id);
  const found = await GroupTopic.find({ group: req.params.id, author: { $nin: [...blocked] } })
    .sort({ pinned: -1, lastActivityAt: -1, _id: -1 })
    .skip((page - 1) * TOPICS_PER_PAGE)
    .limit(TOPICS_PER_PAGE + 1);
  const topics = found.slice(0, TOPICS_PER_PAGE);
  const authors = await publicAuthors(topics, req.user.id);
  res.json({ topics: topics.map((t) => topicShape(t, authors, req.user.id)), page, hasMore: found.length > TOPICS_PER_PAGE });
});

groupBoardRouter.post("/:id/topics", async (req, res) => {
  if (!(await requireMember(req, res))) return;
  const checked = checkTopic(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!(await topicLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(topicLimiter.windowSeconds));
    return res.status(429).json({ error: "You've started a lot of topics — try again later." });
  }
  const topic = await GroupTopic.create({ group: req.params.id, author: req.user.id, title: checked.title, body: checked.body, lastActivityAt: new Date() });
  const authors = await publicAuthors([topic], req.user.id);
  res.status(201).json({ topic: topicShape(topic, authors, req.user.id) });
});

// One topic with its replies, oldest first, fifty a page. A topic or reply by someone you've blocked (or who blocked you) isn't shown;
// a topic that isn't in this group, or whose author is blocked, is a plain 404.
groupBoardRouter.get("/:id/topics/:topicId", async (req, res) => {
  if (!(await requireMember(req, res))) return;
  if (!validId(req.params.topicId)) return res.status(404).json({ error: "Topic not found" });
  const topic = await GroupTopic.findOne({ _id: req.params.topicId, group: req.params.id });
  const blocked = await blockedUserIds(req.user.id);
  if (!topic || blocked.has(String(topic.author))) return res.status(404).json({ error: "Topic not found" });
  const page = Math.min(1000, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const found = await GroupReply.find({ topic: topic._id, author: { $nin: [...blocked] } })
    .sort({ _id: 1 })
    .skip((page - 1) * REPLIES_PER_PAGE)
    .limit(REPLIES_PER_PAGE + 1);
  const replies = found.slice(0, REPLIES_PER_PAGE);
  const authors = await publicAuthors([topic, ...replies], req.user.id);
  res.json({ topic: topicShape(topic, authors, req.user.id), replies: replies.map((r) => replyShape(r, authors, req.user.id)), page, hasMore: found.length > REPLIES_PER_PAGE });
});

groupBoardRouter.post("/:id/topics/:topicId/replies", async (req, res) => {
  if (!(await requireMember(req, res))) return;
  if (!validId(req.params.topicId)) return res.status(404).json({ error: "Topic not found" });
  const body = typeof req.body?.body === "string" ? cleanBody(req.body.body) : "";
  if (!body) return res.status(400).json({ error: "Write something to reply" });
  if (body.length > MAX_REPLY_BODY) return res.status(400).json({ error: `Replies can be up to ${MAX_REPLY_BODY} characters` });
  const topic = await GroupTopic.findOne({ _id: req.params.topicId, group: req.params.id });
  const blocked = await blockedUserIds(req.user.id);
  if (!topic || blocked.has(String(topic.author))) return res.status(404).json({ error: "Topic not found" });
  if (!(await replyLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(replyLimiter.windowSeconds));
    return res.status(429).json({ error: "You're replying too fast — try again in a few minutes." });
  }
  const reply = await GroupReply.create({ topic: topic._id, group: req.params.id, author: req.user.id, body });
  await GroupTopic.updateOne({ _id: topic._id }, { $inc: { replyCount: 1 }, $set: { lastActivityAt: reply.createdAt } });
  const authors = await publicAuthors([reply], req.user.id);
  res.status(201).json({ reply: replyShape(reply, authors, req.user.id) });
});

// The author (and only the author) can change a topic or a reply; group admins moderate by removing. Marked as edited.
groupBoardRouter.patch("/:id/topics/:topicId", async (req, res) => {
  if (!(await requireMember(req, res))) return;
  if (!validId(req.params.topicId)) return res.status(404).json({ error: "Topic not found" });
  const topic = await GroupTopic.findOne({ _id: req.params.topicId, group: req.params.id, author: req.user.id });
  if (!topic) return res.status(404).json({ error: "Topic not found" });
  const checked = checkTopic({ title: req.body?.title ?? topic.title, body: req.body?.body ?? topic.body });
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!(await allowEdit(req, res))) return;
  if (checked.title !== topic.title || checked.body !== topic.body) {
    topic.title = checked.title;
    topic.body = checked.body;
    topic.editedAt = new Date();
    await topic.save();
  }
  const authors = await publicAuthors([topic], req.user.id);
  res.json({ topic: topicShape(topic, authors, req.user.id) });
});

groupBoardRouter.patch("/:id/topics/:topicId/replies/:replyId", async (req, res) => {
  if (!(await requireMember(req, res))) return;
  if (!validId(req.params.topicId) || !validId(req.params.replyId)) return res.status(404).json({ error: "Reply not found" });
  const reply = await GroupReply.findOne({ _id: req.params.replyId, topic: req.params.topicId, group: req.params.id, author: req.user.id });
  if (!reply) return res.status(404).json({ error: "Reply not found" });
  const body = typeof req.body?.body === "string" ? cleanBody(req.body.body) : "";
  if (!body) return res.status(400).json({ error: "Write something to reply" });
  if (body.length > MAX_REPLY_BODY) return res.status(400).json({ error: `Replies can be up to ${MAX_REPLY_BODY} characters` });
  if (!(await allowEdit(req, res))) return;
  if (body !== reply.body) {
    reply.body = body;
    reply.editedAt = new Date();
    await reply.save();
  }
  const authors = await publicAuthors([reply], req.user.id);
  res.json({ reply: replyShape(reply, authors, req.user.id) });
});

// The author of a topic, or an admin of the group, can remove it (with all its replies).
groupBoardRouter.delete("/:id/topics/:topicId", async (req, res) => {
  const membership = await requireMember(req, res);
  if (!membership) return;
  if (!validId(req.params.topicId)) return res.status(404).json({ error: "Topic not found" });
  const topic = await GroupTopic.findOne({ _id: req.params.topicId, group: req.params.id });
  if (!topic || (String(topic.author) !== req.user.id && membership.role !== "admin")) return res.status(404).json({ error: "Topic not found" });
  await GroupReply.deleteMany({ topic: topic._id });
  await topic.deleteOne();
  res.status(204).end();
});

// The author of a reply, or an admin of the group, can remove it.
groupBoardRouter.delete("/:id/topics/:topicId/replies/:replyId", async (req, res) => {
  const membership = await requireMember(req, res);
  if (!membership) return;
  if (!validId(req.params.topicId) || !validId(req.params.replyId)) return res.status(404).json({ error: "Reply not found" });
  const reply = await GroupReply.findOne({ _id: req.params.replyId, topic: req.params.topicId, group: req.params.id });
  if (!reply || (String(reply.author) !== req.user.id && membership.role !== "admin")) return res.status(404).json({ error: "Reply not found" });
  await reply.deleteOne();
  await GroupTopic.updateOne({ _id: reply.topic, replyCount: { $gt: 0 } }, { $inc: { replyCount: -1 } });
  res.status(204).end();
});

// Admins pin up to three topics to the top of the board, and unpin them.
groupBoardRouter.put("/:id/topics/:topicId/pin", async (req, res) => {
  const membership = await requireMember(req, res);
  if (!membership) return;
  if (membership.role !== "admin") return res.status(403).json({ error: "Only a group admin can pin topics" });
  if (typeof req.body?.pinned !== "boolean") return res.status(400).json({ error: "pinned must be true or false" });
  if (!validId(req.params.topicId)) return res.status(404).json({ error: "Topic not found" });
  const topic = await GroupTopic.findOne({ _id: req.params.topicId, group: req.params.id });
  if (!topic) return res.status(404).json({ error: "Topic not found" });
  if (req.body.pinned && !topic.pinned && (await GroupTopic.countDocuments({ group: req.params.id, pinned: true })) >= MAX_PINNED) {
    return res.status(400).json({ error: `You can pin up to ${MAX_PINNED} topics — unpin one first` });
  }
  topic.pinned = req.body.pinned;
  await topic.save();
  const authors = await publicAuthors([topic], req.user.id);
  res.json({ topic: topicShape(topic, authors, req.user.id) });
});
