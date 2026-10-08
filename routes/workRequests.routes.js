import { Router } from "express";
import mongoose from "mongoose";
import { WorkRequest } from "../models/WorkRequest.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { areBlocked, assertVisible, blockedUserIds } from "../utils/visibility.js";
import { cleanLine } from "../utils/profileFields.js";
import { cleanBody } from "../utils/blogText.js";
import { createLimiter } from "../utils/rateLimit.js";

// Requests for work: a person who has said they are open to work can be asked to make or do something, with a short brief. They answer
// yes or no, with a short note the asker sees. Nothing is paid or promised through the site: it only gets the two people talking.
export const workRequestsRouter = Router();
workRequestsRouter.use(requireAuth);

export const MAX_TITLE = 80;
export const MAX_DETAILS = 1000;
export const MAX_BUDGET = 40;
export const MAX_REPLY = 500;
export const MAX_OPEN_TO_ONE_PERSON = 2;
export const MAX_WAITING_FOR_ONE_PERSON = 30;
const sentPerDay = createLimiter({ name: "work-request", limit: 5, windowMs: 24 * 60 * 60 * 1000 });
const answersPerHour = createLimiter({ name: "work-answer", limit: 60, windowMs: 60 * 60 * 1000 });
const validId = (id) => mongoose.isValidObjectId(id);
const bad = (res, error, status = 400) => res.status(status).json({ error });

const person = (u) => ({ id: u._id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl ?? null, csVerified: Boolean(u.csVerifiedByAdmin || u.csVerifiedEarned) });
const serialize = (r, who) => ({ id: r._id, title: r.title, details: r.details, budget: r.budget, deadline: r.deadline, status: r.status, reply: r.reply, answeredAt: r.answeredAt, createdAt: r.createdAt, ...who });
const PEOPLE = "username displayName avatarUrl csVerifiedByAdmin csVerifiedEarned suspendedAt";

/** A deadline as stored: a day written "2026-12-31", in the future and no more than two years ahead. Returns { value } (null for none) or { error }. */
export function checkDeadline(input, now = new Date()) {
  if (input === undefined || input === null || input === "") return { value: null };
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return { error: "Give the deadline as a day, like 2026-12-31" };
  const day = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== input) return { error: "That isn't a real day" };
  if (day.getTime() < now.getTime() - 24 * 60 * 60 * 1000) return { error: "The deadline can't be in the past" };
  if (day.getTime() > now.getTime() + 2 * 365 * 24 * 60 * 60 * 1000) return { error: "The deadline can be at most two years ahead" };
  return { value: day };
}

// Ask a person who is open to work: `{ title, details, budget?, deadline? }`.
workRequestsRouter.post("/to/:username", async (req, res) => {
  const to = await User.findOne({ username: String(req.params.username).toLowerCase() });
  // the same answer for someone missing, someone not taking requests, a private profile and a block, so none of those can be found out
  const notTaking = () => bad(res, "That person isn't taking requests", 404);
  if (!to || to.suspendedAt || to.openToWork !== true) return notTaking();
  if (String(to._id) === String(req.user.id)) return bad(res, "You can't send a request to yourself");
  if (await areBlocked(req.user.id, to._id)) return notTaking();
  try {
    await assertVisible(to, req.user.id);
  } catch {
    return notTaking();
  }

  const title = typeof req.body?.title === "string" ? cleanLine(req.body.title) : "";
  if (!title) return bad(res, "Give your request a title");
  if ([...title].length > MAX_TITLE) return bad(res, `Titles can be up to ${MAX_TITLE} characters`);
  const details = typeof req.body?.details === "string" ? cleanBody(req.body.details) : "";
  if (!details) return bad(res, "Say what you need");
  if ([...details].length > MAX_DETAILS) return bad(res, `Details can be up to ${MAX_DETAILS} characters`);
  const budget = req.body?.budget === undefined || req.body?.budget === null ? "" : typeof req.body.budget === "string" ? cleanLine(req.body.budget) : null;
  if (budget === null || [...budget].length > MAX_BUDGET) return bad(res, `Budgets can be up to ${MAX_BUDGET} characters`);
  const deadline = checkDeadline(req.body?.deadline);
  if (deadline.error) return bad(res, deadline.error);

  if ((await WorkRequest.countDocuments({ from: req.user.id, to: to._id, status: "open" })) >= MAX_OPEN_TO_ONE_PERSON) return bad(res, "You already have requests waiting with them", 409);
  if ((await WorkRequest.countDocuments({ to: to._id, status: "open" })) >= MAX_WAITING_FOR_ONE_PERSON) return bad(res, "They have a lot of requests waiting — try again later", 409);
  if (!(await sentPerDay.allow(req.user.id))) return bad(res, "You've sent a lot of requests today — try again tomorrow.", 429);

  const request = await WorkRequest.create({ from: req.user.id, to: to._id, title, details, budget, deadline: deadline.value });
  await Notification.create({ recipient: to._id, type: "work_request", payload: { actorId: req.user.id, requestId: String(request._id), title } });
  res.status(201).json({ request: serialize(request, { to: person(to) }) });
});

// What people have asked of you: waiting ones first, then answered ones, newest first (people you blocked or who blocked you left out).
workRequestsRouter.get("/received", async (req, res) => {
  const [rows, blocked] = await Promise.all([WorkRequest.find({ to: req.user.id }).sort({ createdAt: -1 }).limit(60), blockedUserIds(req.user.id)]);
  const senders = await User.find({ _id: { $in: rows.map((r) => r.from) } }).select(PEOPLE);
  const byId = new Map(senders.map((u) => [String(u._id), u]));
  const list = rows
    .filter((r) => byId.has(String(r.from)) && !byId.get(String(r.from)).suspendedAt && !blocked.has(String(r.from)))
    .map((r) => serialize(r, { from: person(byId.get(String(r.from))) }));
  list.sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1));
  res.json({ requests: list });
});

// What you have asked of others, and how they answered.
workRequestsRouter.get("/sent", async (req, res) => {
  const rows = await WorkRequest.find({ from: req.user.id }).sort({ createdAt: -1 }).limit(30);
  const people = await User.find({ _id: { $in: rows.map((r) => r.to) } }).select(PEOPLE);
  const byId = new Map(people.map((u) => [String(u._id), u]));
  res.json({ requests: rows.filter((r) => byId.has(String(r.to))).map((r) => serialize(r, { to: person(byId.get(String(r.to))) })) });
});

// Answer a request waiting for you: `{ accept: true | false, reply? }`. The asker is told.
workRequestsRouter.post("/:id/answer", async (req, res) => {
  if (!validId(req.params.id)) return bad(res, "Request not found", 404);
  const request = await WorkRequest.findOne({ _id: req.params.id, to: req.user.id });
  if (!request) return bad(res, "Request not found", 404);
  if (request.status !== "open") return bad(res, "You've already answered that", 409);
  if (typeof req.body?.accept !== "boolean") return bad(res, "Say whether you accept or decline");
  const reply = req.body.reply === undefined || req.body.reply === null ? "" : typeof req.body.reply === "string" ? cleanBody(req.body.reply) : null;
  if (reply === null || [...reply].length > MAX_REPLY) return bad(res, `Replies can be up to ${MAX_REPLY} characters`);
  if (!(await answersPerHour.allow(req.user.id))) return bad(res, "You're replying too fast — try again in a few minutes.", 429);

  request.status = req.body.accept ? "accepted" : "declined";
  request.reply = reply;
  request.answeredAt = new Date();
  await request.save();
  await Notification.deleteMany({ type: "work_request", "payload.requestId": String(request._id) });
  await Notification.create({ recipient: request.from, type: "work_reply", payload: { actorId: req.user.id, requestId: String(request._id), title: request.title, accepted: req.body.accept } });
  res.json({ request: { id: request._id, status: request.status, reply: request.reply, answeredAt: request.answeredAt } });
});

// Take a request away: the asker withdraws one that is still waiting; the person asked clears one they have answered.
workRequestsRouter.delete("/:id", async (req, res) => {
  if (!validId(req.params.id)) return bad(res, "Request not found", 404);
  const request = await WorkRequest.findOne({ _id: req.params.id, $or: [{ from: req.user.id }, { to: req.user.id }] });
  if (!request) return bad(res, "Request not found", 404);
  const asker = String(request.from) === String(req.user.id);
  if (asker ? request.status !== "open" : request.status === "open") return bad(res, asker ? "That has been answered, so it can't be withdrawn" : "Answer it first, then you can clear it", 409);
  await request.deleteOne();
  await Notification.deleteMany({ type: { $in: ["work_request", "work_reply"] }, "payload.requestId": String(request._id) });
  res.status(204).end();
});
