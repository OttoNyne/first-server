import { Router } from "express";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { PING_EVERY_MS } from "../utils/activity.js";

// A signed-in page checks in here every couple of minutes while it is open and visible; that is what "online now" is made of.
export const activityRouter = Router();
activityRouter.use(requireAuth);

activityRouter.post("/ping", async (req, res) => {
  const now = new Date();
  // At most one write a minute per person, and nothing at all for someone who has turned the feature off.
  await User.updateOne(
    { _id: req.user.id, showActivity: { $ne: false }, $or: [{ lastActiveAt: null }, { lastActiveAt: { $lt: new Date(now.getTime() - PING_EVERY_MS) } }] },
    { $set: { lastActiveAt: now } }
  );
  res.status(204).end();
});
