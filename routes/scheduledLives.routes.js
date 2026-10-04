import { Router } from "express";
import mongoose from "mongoose";
import { ScheduledLive } from "../models/ScheduledLive.js";
import { User } from "../models/User.js";
import { Friendship } from "../models/Friendship.js";
import { Notification } from "../models/Notification.js";
import { requireAuth } from "../middleware/auth.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import { blockedUserIds, assertVisible } from "../utils/visibility.js";
import { toPublicUser } from "../utils/serialize.js";
import { createLimiter } from "../utils/rateLimit.js";
import { KEEP_AFTER_MS, processDueReminders, removePlanNotifications } from "../services/scheduledLives.js";

// Planned lives: a host picks a title and a time, friends are told, and anyone who can see the host can ask for a reminder.
export const scheduledLivesRouter = Router();
scheduledLivesRouter.use(requireAuth);

const MIN_LEAD_MS = 5 * 60 * 1000; // a plan is for later, not for now
const MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PLANS_PER_HOST = 5;
const SHOW_AFTER_START_MS = 30 * 60 * 1000; // a plan stays listed for a while after its time, for people running late
const MAX_TITLE = 80;

const scheduleLimiter = createLimiter({ name: "live-schedule", limit: 10, windowMs: 60 * 60 * 1000 });
const validId = (id) => mongoose.isValidObjectId(id);

async function serialize(plan, host, viewerId) {
  return {
    id: plan._id,
    title: plan.title,
    startsAt: plan.startsAt,
    host: await toPublicUser(host, viewerId),
    isHost: String(plan.host) === String(viewerId),
    reminding: plan.reminders.some((r) => String(r) === String(viewerId)),
    reminderCount: plan.reminders.length,
  };
}

// What the viewer may see: plans from hosts they haven't blocked (or been blocked by), and from private-profile hosts only
// if they are friends (or the host themselves).
scheduledLivesRouter.get("/", async (req, res) => {
  await processDueReminders();
  const plans = await ScheduledLive.find({ status: "scheduled", startsAt: { $gt: new Date(Date.now() - SHOW_AFTER_START_MS) } })
    .sort("startsAt")
    .limit(100);
  const hosts = await User.find({ _id: { $in: plans.map((p) => p.host) } });
  const hostById = new Map(hosts.map((h) => [String(h._id), h]));
  const blocked = await blockedUserIds(req.user.id);
  const friendships = await Friendship.find({ status: "accepted", $or: [{ requester: req.user.id }, { addressee: req.user.id }] });
  const friendIds = new Set(friendships.map((f) => (String(f.requester) === req.user.id ? String(f.addressee) : String(f.requester))));

  const visible = plans.filter((p) => {
    const host = hostById.get(String(p.host));
    if (!host || blocked.has(String(host._id))) return false;
    return !host.isPrivate || String(host._id) === req.user.id || friendIds.has(String(host._id));
  });
  res.json({ scheduled: await Promise.all(visible.slice(0, 50).map((p) => serialize(p, hostById.get(String(p.host)), req.user.id))) });
});

scheduledLivesRouter.post("/", requireVerifiedEmail, async (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!title) return res.status(400).json({ error: "Give your live a title" });
  if (title.length > MAX_TITLE) return res.status(400).json({ error: `Titles can be up to ${MAX_TITLE} characters` });
  const startsAt = typeof req.body?.startsAt === "string" ? new Date(req.body.startsAt) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) return res.status(400).json({ error: "Choose a start time" });
  const lead = startsAt.getTime() - Date.now();
  if (lead < MIN_LEAD_MS) return res.status(400).json({ error: "Choose a time at least 5 minutes from now" });
  if (lead > MAX_LEAD_MS) return res.status(400).json({ error: "You can schedule up to 30 days ahead" });
  if ((await ScheduledLive.countDocuments({ host: req.user.id, status: "scheduled" })) >= MAX_PLANS_PER_HOST) {
    return res.status(400).json({ error: `You can have up to ${MAX_PLANS_PER_HOST} lives scheduled at once` });
  }
  if (!(await scheduleLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(scheduleLimiter.windowSeconds));
    return res.status(429).json({ error: "You've scheduled a lot of lives — try again later." });
  }

  const plan = await ScheduledLive.create({ host: req.user.id, title, startsAt, expireAt: new Date(startsAt.getTime() + KEEP_AFTER_MS) });
  const host = await User.findById(req.user.id);
  await announce(plan, req.user.id);
  res.status(201).json({ scheduled: await serialize(plan, host, req.user.id) });
});

// Tells the host's accepted friends about it. A failure here must never stop the plan from being made.
async function announce(plan, hostId) {
  try {
    const friendships = await Friendship.find({ status: "accepted", $or: [{ requester: hostId }, { addressee: hostId }] });
    const friendIds = friendships.map((f) => (String(f.requester) === String(hostId) ? f.addressee : f.requester));
    if (!friendIds.length) return;
    await Notification.insertMany(friendIds.map((recipient) => ({ recipient, type: "live_scheduled", payload: { actorId: String(hostId), scheduledId: String(plan._id), title: plan.title, startsAt: plan.startsAt.toISOString() } })));
  } catch (err) {
    console.error("Couldn't announce a scheduled live:", err.message);
  }
}

async function loadMine(req, res) {
  if (!validId(req.params.id)) return void res.status(404).json({ error: "Scheduled live not found" });
  const plan = await ScheduledLive.findOne({ _id: req.params.id, host: req.user.id, status: "scheduled" });
  if (!plan) return void res.status(404).json({ error: "Scheduled live not found" });
  return plan;
}

scheduledLivesRouter.delete("/:id", async (req, res) => {
  const plan = await loadMine(req, res);
  if (!plan) return;
  await ScheduledLive.updateOne({ _id: plan._id }, { $set: { status: "cancelled" } });
  await removePlanNotifications(plan._id);
  res.status(204).end();
});

// Ask to be reminded (or stop asking). Only people who can see the host may.
async function loadVisible(req, res) {
  if (!validId(req.params.id)) return void res.status(404).json({ error: "Scheduled live not found" });
  const plan = await ScheduledLive.findOne({ _id: req.params.id, status: "scheduled" });
  if (!plan) return void res.status(404).json({ error: "Scheduled live not found" });
  try {
    await assertVisible(await User.findById(plan.host), req.user.id);
  } catch {
    return void res.status(404).json({ error: "Scheduled live not found" }); // same answer as a plan that doesn't exist
  }
  return plan;
}

scheduledLivesRouter.post("/:id/remind", async (req, res) => {
  const plan = await loadVisible(req, res);
  if (!plan) return;
  if (String(plan.host) === req.user.id) return res.status(400).json({ error: "You'll be told about your own live" });
  if (plan.startsAt.getTime() < Date.now() - SHOW_AFTER_START_MS) return res.status(409).json({ error: "That live has already started" });
  const updated = await ScheduledLive.findOneAndUpdate({ _id: plan._id }, { $addToSet: { reminders: req.user.id } }, { new: true });
  res.json({ reminding: true, reminderCount: updated.reminders.length });
});

scheduledLivesRouter.delete("/:id/remind", async (req, res) => {
  const plan = await loadVisible(req, res);
  if (!plan) return;
  const updated = await ScheduledLive.findOneAndUpdate({ _id: plan._id }, { $pull: { reminders: req.user.id } }, { new: true });
  res.json({ reminding: false, reminderCount: updated.reminders.length });
});
