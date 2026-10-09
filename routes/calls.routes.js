import { Router } from "express";
import mongoose from "mongoose";
import { Call } from "../models/Call.js";
import { CallApplication } from "../models/CallApplication.js";
import { MediaItem } from "../models/MediaItem.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { Friendship } from "../models/Friendship.js";
import { requireAuth } from "../middleware/auth.js";
import { deleteApplication, deleteCall } from "../services/removal.js";
import { ensureProject, roomIsFull } from "../services/projects.js";
import { Project } from "../models/Project.js";
import { verifiedEmailRequired, userHasVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import { createLimiter } from "../utils/rateLimit.js";
import { cleanBody } from "../utils/blogText.js";
import { cursorFilter } from "../utils/textInput.js";
import { blockedUserIds } from "../utils/visibility.js";
import { mutedUserIds } from "../utils/mutes.js";
import { MAX_APPLICATIONS, MAX_NOTE, MAX_OPEN_CALLS, MAX_REPLY, findMatches, isClosed, matchedRoles, peopleToTell, readCall, startOfToday } from "../utils/calls.js";

// Open calls: a public board where someone says what they are looking for (a vocalist, an illustrator, a photographer for a shoot) and people
// who might fit apply with a few words and one of their own pieces. The site suggests the people who fit, and tells the ones who do. Nothing
// is paid or promised through it. Who sees a call is whoever may see its owner's profile, and anything else is the same 404 as a missing call.
export const callsRouter = Router();
callsRouter.use(requireAuth);

const PAGE = 20;
const SCAN = 60;
const ROUNDS = 3;
const createLimit = createLimiter({ name: "call-create", limit: 10, windowMs: 24 * 60 * 60 * 1000 });
const applyLimit = createLimiter({ name: "call-apply", limit: 20, windowMs: 24 * 60 * 60 * 1000 });
const answerLimit = createLimiter({ name: "call-answer", limit: 60, windowMs: 60 * 60 * 1000 });
const bad = (res, error, status = 400) => res.status(status).json({ error });
const notFound = (res) => bad(res, "Call not found", 404);
const validId = (id) => mongoose.isValidObjectId(id);

const person = (u) => ({ id: u._id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl ?? null, csVerified: Boolean(u.csVerifiedByAdmin || u.csVerifiedEarned) });
const PEOPLE = "username displayName avatarUrl csVerifiedByAdmin csVerifiedEarned suspendedAt isPrivate workOffers tags";
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function toPublicCall(call, owner, viewer, extra = {}) {
  return {
    id: call._id,
    title: call.title,
    details: call.details,
    lookingFor: call.lookingFor,
    budget: call.budget,
    deadline: day(call.deadline),
    status: call.status,
    closed: isClosed(call),
    createdAt: call.createdAt,
    owner: person(owner),
    mine: String(owner._id) === String(viewer),
    ...extra,
  };
}

/** Who a viewer may see: not suspended, not blocked either way, and not private unless a friend. */
async function viewerLimits(viewerId) {
  const [blocked, friendships] = await Promise.all([blockedUserIds(viewerId), Friendship.find({ status: "accepted", $or: [{ requester: viewerId }, { addressee: viewerId }] })]);
  const friends = new Set(friendships.map((f) => (String(f.requester) === String(viewerId) ? String(f.addressee) : String(f.requester))));
  return (owner) => Boolean(owner) && !owner.suspendedAt && !blocked.has(String(owner._id)) && (!owner.isPrivate || friends.has(String(owner._id)) || String(owner._id) === String(viewerId));
}

/** A call and its owner, if the viewer may see it; otherwise null. */
async function loadVisible(id, viewerId) {
  if (!validId(id)) return null;
  const call = await Call.findById(id).populate("owner", PEOPLE);
  if (!call?.owner) return null;
  const may = await viewerLimits(viewerId);
  return may(call.owner) ? call : null;
}

// The board: open calls, newest first, 20 a page (?before=<id>); ?for=me keeps those that fit what you offer; ?tag= those looking for a role.
callsRouter.get("/", async (req, res) => {
  const me = await User.findById(req.user.id).select("workOffers tags");
  const onlyMine = req.query.for === "me";
  const tag = typeof req.query.tag === "string" ? req.query.tag.trim().toLowerCase() : "";
  const [may, muted] = await Promise.all([viewerLimits(req.user.id), mutedUserIds(req.user.id)]);
  const base = { status: "open", owner: { $ne: req.user.id }, $or: [{ deadline: null }, { deadline: { $gte: startOfToday() } }] };
  if (tag) base.lookingFor = tag;
  const kept = [];
  let cursor = cursorFilter(req.query, mongoose);
  let exhausted = false;
  for (let round = 0; round < ROUNDS && kept.length <= PAGE; round++) {
    const found = await Call.find({ ...base, ...(cursor ? { _id: { $lt: cursor } } : {}) }).sort({ _id: -1 }).limit(SCAN).populate("owner", PEOPLE);
    for (const call of found) {
      cursor = call._id;
      if (!may(call.owner) || muted.has(String(call.owner._id))) continue;
      const match = matchedRoles(call.lookingFor, me);
      if (onlyMine && !match.length) continue;
      kept.push({ call, match });
      if (kept.length > PAGE) break;
    }
    if (found.length < SCAN) {
      exhausted = true;
      break;
    }
  }
  const shown = kept.slice(0, PAGE);
  const applied = new Map((await CallApplication.find({ applicant: req.user.id, call: { $in: shown.map((k) => k.call._id) } }).select("call status").lean()).map((a) => [String(a.call), a.status]));
  res.json({
    calls: shown.map(({ call, match }) => toPublicCall(call, call.owner, req.user.id, { match, applied: applied.get(String(call._id)) ?? null })),
    hasMore: kept.length > PAGE || !exhausted,
    next: shown.length ? String(shown[shown.length - 1].call._id) : null,
  });
});

// Your own calls, any state, newest first, with how many have applied.
callsRouter.get("/mine", async (req, res) => {
  const calls = await Call.find({ owner: req.user.id }).sort({ _id: -1 }).limit(50).populate("owner", PEOPLE);
  const counts = await CallApplication.aggregate([{ $match: { call: { $in: calls.map((c) => c._id) } } }, { $group: { _id: { call: "$call", status: "$status" }, n: { $sum: 1 } } }]);
  const tally = new Map();
  for (const c of counts) {
    const t = tally.get(String(c._id.call)) ?? { total: 0, waiting: 0 };
    t.total += c.n;
    if (c._id.status === "waiting") t.waiting += c.n;
    tally.set(String(c._id.call), t);
  }
  res.json({ calls: calls.map((c) => toPublicCall(c, c.owner, req.user.id, { applicantCount: tally.get(String(c._id))?.total ?? 0, waitingCount: tally.get(String(c._id))?.waiting ?? 0 })) });
});

// Your own applications, newest first: which call, and how it went.
callsRouter.get("/applied", async (req, res) => {
  const rows = await CallApplication.find({ applicant: req.user.id }).sort({ _id: -1 }).limit(50).populate({ path: "call", populate: { path: "owner", select: PEOPLE } });
  const may = await viewerLimits(req.user.id);
  res.json({
    applications: rows.filter((r) => r.call?.owner && may(r.call.owner)).map((r) => ({ id: r._id, status: r.status, reply: r.reply, createdAt: r.createdAt, call: toPublicCall(r.call, r.call.owner, req.user.id) })),
  });
});

// Post a call.
callsRouter.post("/", async (req, res) => {
  const checked = readCall(req.body);
  if (checked.error) return bad(res, checked.error);
  if (verifiedEmailRequired() && !(await userHasVerifiedEmail(req.user.id))) return bad(res, "Confirm your email address first — check your inbox for the link.", 403);
  if ((await Call.countDocuments({ owner: req.user.id, status: "open" })) >= MAX_OPEN_CALLS) return bad(res, `You can have up to ${MAX_OPEN_CALLS} open calls — close one first`, 409);
  if (!(await createLimit.allow(req.user.id))) return bad(res, "You've posted a lot of calls today — try again tomorrow.", 429);
  const call = await Call.create({ ...checked.value, owner: req.user.id });
  // tell the people it fits (a few, so a call can't be used to ping the whole site)
  const told = await peopleToTell(call);
  if (told.length) await Notification.insertMany(told.map((recipient) => ({ recipient, type: "call_match", payload: { actorId: String(req.user.id), callId: String(call._id), title: call.title } })));
  const owner = await User.findById(req.user.id).select(PEOPLE);
  res.status(201).json({ call: toPublicCall(call, owner, req.user.id, { applicantCount: 0, waitingCount: 0 }), told: told.length });
});

// One call.
callsRouter.get("/:id", async (req, res) => {
  const call = await loadVisible(req.params.id, req.user.id);
  if (!call) return notFound(res);
  const mine = String(call.owner._id) === req.user.id;
  const me = await User.findById(req.user.id).select("workOffers tags");
  const application = mine ? null : await CallApplication.findOne({ call: call._id, applicant: req.user.id });
  // the room for this call, for the person who asked and for anyone they chose
  const room = await Project.findOne({ call: call._id }).select("members");
  const inRoom = room && room.members.some((m) => String(m) === req.user.id);
  const counts = mine ? { applicantCount: await CallApplication.countDocuments({ call: call._id }), waitingCount: await CallApplication.countDocuments({ call: call._id, status: "waiting" }) } : {};
  res.json({
    call: toPublicCall(call, call.owner, req.user.id, {
      match: mine ? [] : matchedRoles(call.lookingFor, me),
      applied: application?.status ?? null,
      myApplication: application ? { id: application._id, note: application.note, status: application.status, reply: application.reply, pieceId: application.piece ?? null } : null,
      projectId: inRoom ? room._id : null,
      ...counts,
    }),
  });
});

// Change your call: any of title, details, lookingFor, budget, deadline, or `status` ("open" or "closed").
callsRouter.patch("/:id", async (req, res) => {
  const call = validId(req.params.id) ? await Call.findOne({ _id: req.params.id, owner: req.user.id }) : null;
  if (!call) return notFound(res);
  const checked = readCall(req.body, { partial: true });
  if (checked.error) return bad(res, checked.error);
  const changes = { ...checked.value };
  if (req.body && Object.hasOwn(req.body, "status")) {
    if (!["open", "closed"].includes(req.body.status)) return bad(res, "Status must be open or closed");
    changes.status = req.body.status;
  }
  if (!Object.keys(changes).length) return bad(res, "Nothing to change");
  const next = { ...call.toObject(), ...changes };
  if (changes.status === "open" && call.status === "closed") {
    if (isClosed({ ...next, status: "open" })) return bad(res, "The deadline has passed, so it can't be reopened");
    if ((await Call.countDocuments({ owner: req.user.id, status: "open" })) >= MAX_OPEN_CALLS) return bad(res, `You can have up to ${MAX_OPEN_CALLS} open calls — close one first`, 409);
  }
  Object.assign(call, changes);
  if (changes.status) call.closedAt = changes.status === "closed" ? new Date() : null;
  await call.save();
  const owner = await User.findById(req.user.id).select(PEOPLE);
  res.json({ call: toPublicCall(call, owner, req.user.id) });
});

// Take your call down, with its applications and the notices about it.
callsRouter.delete("/:id", async (req, res) => {
  const call = validId(req.params.id) ? await Call.findOne({ _id: req.params.id, owner: req.user.id }) : null;
  if (!call) return notFound(res);
  await deleteCall(call);
  res.status(204).end();
});

// Apply: `{ note?, piece? }` with a few words and/or one of your own portfolio pieces. Once per call.
callsRouter.post("/:id/apply", async (req, res) => {
  const call = await loadVisible(req.params.id, req.user.id);
  if (!call) return notFound(res);
  if (String(call.owner._id) === req.user.id) return bad(res, "You can't apply to your own call");
  if (isClosed(call)) return bad(res, "This call is closed", 409);
  const rawNote = req.body?.note;
  const note = rawNote === undefined || rawNote === null ? "" : typeof rawNote === "string" ? cleanBody(rawNote) : null;
  if (note === null || [...note].length > MAX_NOTE) return bad(res, `A note can be up to ${MAX_NOTE} characters`);
  let piece = null;
  if (req.body?.piece !== undefined && req.body.piece !== null) {
    piece = validId(req.body.piece) ? await MediaItem.findOne({ _id: req.body.piece, owner: req.user.id }) : null;
    if (!piece) return bad(res, "Choose one of your own pieces");
  }
  if (!note && !piece) return bad(res, "Write a few words, or choose one of your pieces");
  if (await CallApplication.exists({ call: call._id, applicant: req.user.id })) return bad(res, "You have already applied to this call", 409);
  if ((await CallApplication.countDocuments({ call: call._id })) >= MAX_APPLICATIONS) return bad(res, "This call has enough applications for now", 409);
  if (!(await applyLimit.allow(req.user.id))) return bad(res, "You've applied to a lot of calls today — try again tomorrow.", 429);
  let application;
  try {
    application = await CallApplication.create({ call: call._id, applicant: req.user.id, note, piece: piece?._id ?? null });
  } catch (err) {
    if (err?.code !== 11000) throw err; // two taps at once
    return bad(res, "You have already applied to this call", 409);
  }
  await Notification.create({ recipient: call.owner._id, type: "call_application", payload: { actorId: String(req.user.id), callId: String(call._id), title: call.title } });
  res.status(201).json({ application: { id: application._id, status: application.status } });
});

// Take your application back while it is still waiting.
callsRouter.delete("/:id/apply", async (req, res) => {
  const application = validId(req.params.id) ? await CallApplication.findOne({ call: req.params.id, applicant: req.user.id }) : null;
  if (!application) return bad(res, "Application not found", 404);
  if (application.status !== "waiting") return bad(res, "That has been answered, so it can't be withdrawn", 409);
  await deleteApplication(application);
  res.status(204).end();
});

/** The call, if it is the viewer's own; otherwise null. */
const ownCall = (id, userId) => (validId(id) ? Call.findOne({ _id: id, owner: userId }) : null);

// Who applied (the owner only): waiting ones first, then answered, newest first; people who blocked you or you blocked are left out.
callsRouter.get("/:id/applications", async (req, res) => {
  const call = await ownCall(req.params.id, req.user.id);
  if (!call) return notFound(res);
  const [rows, blocked] = await Promise.all([CallApplication.find({ call: call._id }).sort({ _id: -1 }).limit(MAX_APPLICATIONS).populate("applicant", PEOPLE).populate("piece"), blockedUserIds(req.user.id)]);
  const list = rows
    .filter((r) => r.applicant && !r.applicant.suspendedAt && !blocked.has(String(r.applicant._id)))
    .map((r) => ({
      id: r._id,
      applicant: person(r.applicant),
      note: r.note,
      piece: r.piece ? { id: r.piece._id, url: r.piece.url, type: r.piece.type, caption: r.piece.caption } : null,
      status: r.status,
      reply: r.reply,
      createdAt: r.createdAt,
    }));
  list.sort((a, b) => (a.status === "waiting" ? 0 : 1) - (b.status === "waiting" ? 0 : 1));
  res.json({ applications: list });
});

// Choose an applicant or pass: `{ choose: true | false, reply? }`. They are told. Once.
callsRouter.post("/:id/applications/:appId/answer", async (req, res) => {
  const call = await ownCall(req.params.id, req.user.id);
  if (!call) return notFound(res);
  const application = validId(req.params.appId) ? await CallApplication.findOne({ _id: req.params.appId, call: call._id }) : null;
  if (!application) return bad(res, "Application not found", 404);
  if (application.status !== "waiting") return bad(res, "You've already answered that", 409);
  if (typeof req.body?.choose !== "boolean") return bad(res, "Say whether you choose them or not");
  const rawReply = req.body.reply;
  const reply = rawReply === undefined || rawReply === null ? "" : typeof rawReply === "string" ? cleanBody(rawReply) : null;
  if (reply === null || [...reply].length > MAX_REPLY) return bad(res, `Replies can be up to ${MAX_REPLY} characters`);
  if (req.body.choose && (await roomIsFull(call, application.applicant))) return bad(res, "This project room is full", 409);
  if (!(await answerLimit.allow(req.user.id))) return bad(res, "You're replying too fast — try again in a few minutes.", 429);
  application.status = req.body.choose ? "chosen" : "passed";
  application.reply = reply;
  application.answeredAt = new Date();
  await application.save();
  await Notification.deleteMany({ type: "call_application", "payload.callId": String(call._id), "payload.actorId": String(application.applicant) });
  // choosing someone opens (or adds them to) the project room for the call
  const room = req.body.choose ? (await ensureProject(call, application.applicant)).project : null;
  await Notification.create({ recipient: application.applicant, type: "call_answer", payload: { actorId: String(req.user.id), callId: String(call._id), title: call.title, chosen: req.body.choose, ...(room ? { projectId: String(room._id) } : {}) } });
  res.json({ application: { id: application._id, status: application.status, reply: application.reply, answeredAt: application.answeredAt, projectId: room?._id ?? null } });
});

// People who might fit (the owner only): open to work, with something in common with what the call looks for, best fit first.
callsRouter.get("/:id/matches", async (req, res) => {
  const call = await ownCall(req.params.id, req.user.id);
  if (!call) return notFound(res);
  const applied = (await CallApplication.find({ call: call._id }).select("applicant").lean()).map((a) => a.applicant);
  const matches = await findMatches(call, { exclude: applied });
  res.json({ people: matches.map(({ user, matched }) => ({ ...person(user), matched, workNote: user.workNote ?? "" })) });
});
