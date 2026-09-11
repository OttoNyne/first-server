import { Router } from "express";
import { User } from "../models/User.js";
import { Block } from "../models/Block.js";
import { Friendship } from "../models/Friendship.js";
import { Report } from "../models/Report.js";
import { requireAuth } from "../middleware/auth.js";

export const moderationRouter = Router();
moderationRouter.use(requireAuth);

moderationRouter.post("/users/:username/block", async (req, res) => {
  const target = await User.findOne({ username: req.params.username });
  if (!target) return res.status(404).json({ error: "User not found" });

  await Friendship.deleteMany({
    $or: [
      { requester: req.user.id, addressee: target._id },
      { requester: target._id, addressee: req.user.id },
    ],
  });

  await Block.findOneAndUpdate(
    { blocker: req.user.id, blocked: target._id },
    { blocker: req.user.id, blocked: target._id },
    { upsert: true }
  );

  res.status(204).end();
});

moderationRouter.delete("/users/:username/block", async (req, res) => {
  const target = await User.findOne({ username: req.params.username });
  if (!target) return res.status(404).json({ error: "User not found" });
  await Block.deleteOne({ blocker: req.user.id, blocked: target._id });
  res.status(204).end();
});

moderationRouter.post("/reports", async (req, res) => {
  const report = await Report.create({
    reporter: req.user.id,
    targetType: req.body.targetType,
    targetId: req.body.targetId,
    reason: req.body.reason,
  });
  res.status(201).json({ report });
});
