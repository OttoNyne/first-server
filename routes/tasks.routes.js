import { Router } from "express";
import { Task } from "../models/Task.js";
import { requireAuth } from "../middleware/auth.js";

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
  const task = await Task.create({ ...req.body, owner: req.user.id });
  res.status(201).json(task);
});

tasksRouter.put("/:id", async (req, res) => {
  const updates = {};
  if (req.body.title !== undefined) updates.title = req.body.title;
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
