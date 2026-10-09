import { Router } from "express";
import { Follow } from "../models/Follow.js";
import { User } from "../models/User.js";
import { Block } from "../models/Block.js";
import { Friendship } from "../models/Friendship.js";
import { Report } from "../models/Report.js";
import { requireAuth } from "../middleware/auth.js";
import { removeListenersBetween } from "./live.routes.js";
import mongoose from "mongoose";
import { createLimiter } from "../utils/rateLimit.js";
import { cleanLine } from "../utils/profileFields.js";
import { loadTarget } from "../services/moderation.js";
import { Project } from "../models/Project.js";
import { ProjectMessage } from "../models/ProjectMessage.js";

export const moderationRouter = Router();
moderationRouter.use(requireAuth);

moderationRouter.post("/users/:username/block", async (req, res) => {
  const target = await User.findOne({ username: req.params.username });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (String(target._id) === req.user.id) {
    return res.status(400).json({ error: "Cannot block yourself" });
  }

  await Friendship.deleteMany({
    $or: [
      { requester: req.user.id, addressee: target._id },
      { requester: target._id, addressee: req.user.id },
    ],
  });

  // and neither follows the other any more
  await Follow.deleteMany({ $or: [{ follower: req.user.id, following: target._id }, { follower: target._id, following: req.user.id }] });

  await Block.findOneAndUpdate(
    { blocker: req.user.id, blocked: target._id },
    { blocker: req.user.id, blocked: target._id },
    { upsert: true }
  );
  // neither person stays in the other's voice live
  await removeListenersBetween(req.user.id, target._id);

  res.status(204).end();
});

moderationRouter.delete("/users/:username/block", async (req, res) => {
  const target = await User.findOne({ username: req.params.username });
  if (!target) return res.status(404).json({ error: "User not found" });
  await Block.deleteOne({ blocker: req.user.id, blocked: target._id });
  res.status(204).end();
});

const REPORT_TARGET_TYPES = ["user", "post", "comment", "profileComment", "blogEntry", "bulletin", "groupTopic", "groupReply", "mediaComment", "event", "blogComment", "piece", "processStep", "call", "callApplication", "projectMessage"];

const reportLimiter = createLimiter({ name: "report", limit: 30, windowMs: 60 * 60 * 1000 });

moderationRouter.post("/reports", async (req, res) => {
  const { targetType, targetId } = req.body ?? {};
  if (!REPORT_TARGET_TYPES.includes(targetType)) {
    return res.status(400).json({ error: "Invalid targetType" });
  }
  const reason = typeof req.body?.reason === "string" ? cleanLine(req.body.reason) : "";
  if (!targetId || !reason) {
    return res.status(400).json({ error: "targetId and reason are required" });
  }
  if (reason.length > 500) return res.status(400).json({ error: "Reasons can be up to 500 characters" });
  if (!mongoose.isValidObjectId(targetId)) return res.status(400).json({ error: "targetId isn't valid" });
  if (targetType === "user" && String(targetId) === req.user.id) return res.status(400).json({ error: "You can't report yourself" });
  // a message in a private room can only be reported by someone in that room, and anyone else gets the answer for a missing one
  if (targetType === "projectMessage") {
    const message = await ProjectMessage.findById(targetId).select("project");
    const room = message ? await Project.findOne({ _id: message.project, members: req.user.id }).select("_id") : null;
    if (!room) return res.status(404).json({ error: "That doesn't exist any more" });
  }
  // Only things that exist can be reported, so the queue doesn't fill with references to nothing.
  if (!(await loadTarget(targetType, targetId, req.user.id)).exists) return res.status(404).json({ error: "That doesn't exist any more" });

  // Reporting the same thing twice while the first report is still waiting changes nothing.
  const already = await Report.findOne({ reporter: req.user.id, targetType, targetId, status: "open" });
  if (already) return res.status(200).json({ report: already, duplicate: true });
  if (!(await reportLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(reportLimiter.windowSeconds));
    return res.status(429).json({ error: "You've sent a lot of reports — try again later." });
  }

  const report = await Report.create({ reporter: req.user.id, targetType, targetId, reason });
  res.status(201).json({ report });
});
