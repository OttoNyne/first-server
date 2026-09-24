import { Router } from "express";
import { Task } from "../models/Task.js";
import { Notification } from "../models/Notification.js";
import { Block } from "../models/Block.js";
import { Friendship } from "../models/Friendship.js";
import { requireAuth } from "../middleware/auth.js";
import { toPublicUser } from "../utils/serialize.js";
import { assertVisible } from "../utils/visibility.js";

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

tasksRouter.get("/", async (req, res) => {
  const filter = { owner: req.user.id };
  if (req.query.done !== undefined) {
    filter.done = req.query.done === "true";
  }
  // req.query.sort is an array if the client repeats the query param
  // (?sort=a&sort=b) — Mongoose's .sort() rejects that shape, so normalize
  // to a single string before it ever reaches the query.
  let sort = req.query.sort;
  if (Array.isArray(sort)) sort = sort[0];
  if (typeof sort !== "string" || !sort) sort = "-createdAt";

  let page = parseInt(req.query.page);
  if (!Number.isInteger(page) || page < 1) {
    page = 1;
  }

  let limit = parseInt(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    limit = 20;
  }
  limit = Math.min(limit, 100);

  const skip = (page - 1) * limit;

  const tasks = await Task.find(filter).sort(sort).limit(limit).skip(skip);
  res.json(tasks);
});

// The public Help wanted board: open, public requests from other users. Every
// author still goes through the same visibility rules as their profile —
// blocked either way, or a private profile viewed by a non-friend, and the
// request is hidden entirely (not just anonymised).
tasksRouter.get("/board", async (req, res) => {
  const me = req.user.id;
  const tasks = await Task.find({ isPublic: true, done: false, owner: { $ne: me } })
    .sort("-createdAt")
    .limit(100)
    .populate("owner");

  const [blocks, friendships] = await Promise.all([
    Block.find({ $or: [{ blocker: me }, { blocked: me }] }),
    Friendship.find({ status: "accepted", $or: [{ requester: me }, { addressee: me }] }),
  ]);
  const blockedIds = new Set(blocks.map((b) => String(b.blocker) === me ? String(b.blocked) : String(b.blocker)));
  const friendIds = new Set(friendships.map((f) => String(f.requester) === me ? String(f.addressee) : String(f.requester)));

  const visible = tasks.filter((t) => {
    const owner = t.owner;
    if (!owner) return false;
    const id = String(owner._id);
    if (blockedIds.has(id)) return false;
    return !owner.isPrivate || friendIds.has(id);
  });

  res.json({
    tasks: await Promise.all(
      visible.map(async (t) => ({
        _id: t._id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        dueDate: t.dueDate,
        createdAt: t.createdAt,
        author: await toPublicUser(t.owner, me),
      }))
    ),
  });
});

// Offer to help with someone's public request: notifies the owner (once per
// offerer per request) — the owner then follows up via the offerer's profile.
tasksRouter.post("/:id/offer", async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, isPublic: true, done: false }).populate("owner");
  if (!task || !task.owner) return res.status(404).json({ error: "Request not found" });
  if (String(task.owner._id) === req.user.id) {
    return res.status(400).json({ error: "You can't offer help on your own request" });
  }
  try {
    await assertVisible(task.owner, req.user.id);
  } catch {
    // Same answer as a missing request so a private/blocking owner isn't revealed.
    return res.status(404).json({ error: "Request not found" });
  }

  const already = await Notification.findOne({
    recipient: task.owner._id,
    type: "help_offer",
    "payload.taskId": task._id,
    "payload.actorId": req.user.id,
  });
  if (!already) {
    await Notification.create({
      recipient: task.owner._id,
      type: "help_offer",
      payload: { taskId: task._id, title: task.title, actorId: req.user.id },
    });
  }
  res.status(201).json({ message: "Offer sent" });
});

tasksRouter.get("/:id", async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, owner: req.user.id });
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  res.json(task);
});

tasksRouter.post("/", async (req, res) => {
  if (!req.body.title) {
    return res.status(400).json({ error: "title is required" });
  }
  const { title, description, priority, dueDate, isPublic } = req.body;
  const task = await Task.create({ title, description, priority, dueDate, isPublic, owner: req.user.id });
  res.status(201).json(task);
});

tasksRouter.put("/:id", async (req, res) => {
  const updates = {};
  if (req.body.title !== undefined) updates.title = req.body.title;
  if (req.body.description !== undefined) updates.description = req.body.description;
  if (req.body.isPublic !== undefined) updates.isPublic = req.body.isPublic;
  if (req.body.done !== undefined) updates.done = req.body.done;
  if (req.body.priority !== undefined) updates.priority = req.body.priority;
  if (req.body.dueDate !== undefined) updates.dueDate = req.body.dueDate;

  const task = await Task.findOneAndUpdate(
    { _id: req.params.id, owner: req.user.id },
    updates,
    { new: true }
  );
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  res.json(task);
});

tasksRouter.delete("/:id", async (req, res) => {
  const task = await Task.findOneAndDelete({ _id: req.params.id, owner: req.user.id });
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  res.json({ message: "Task deleted" });
});
