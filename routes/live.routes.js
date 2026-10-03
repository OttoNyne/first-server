import { Router } from "express";
import mongoose from "mongoose";
import { LiveSession, LiveListener, LiveSignal, LiveComment } from "../models/Live.js";
import { User } from "../models/User.js";
import { Friendship } from "../models/Friendship.js";
import { Notification } from "../models/Notification.js";
import { requireAuth } from "../middleware/auth.js";
import { assertVisible, blockedUserIds } from "../utils/visibility.js";
import { toPublicUser } from "../utils/serialize.js";
import { createLimiter } from "../utils/rateLimit.js";

// Voice-only live rooms. The audio itself never touches this server: the host's
// browser sends it straight to each listener over WebRTC. This API only lists the
// rooms, counts listeners, passes the WebRTC handshake messages ("signals") between
// browsers, and carries the live chat. Because the host uploads one copy of the audio
// per listener, a room is capped at MAX_LISTENERS; a media server (an SFU) would be
// the way past that.
export const MAX_LISTENERS = 8;
const HOST_STALE_MS = 45_000; // no heartbeat for this long = the live is over
const LISTENER_STALE_MS = 30_000;
const SIGNAL_TTL_MS = 5 * 60 * 1000;
const COMMENT_TTL_MS = 24 * 60 * 60 * 1000;
const ENDED_KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_SIGNAL_BYTES = 20_000;
const MAX_COMMENT_LENGTH = 200;
const COMMENT_PAGE = 50;

const startLimiter = createLimiter({ name: "live-start", limit: 5, windowMs: 60 * 60 * 1000 });
const joinLimiter = createLimiter({ name: "live-join", limit: 120, windowMs: 60 * 60 * 1000 });
const signalLimiter = createLimiter({ name: "live-signal", limit: 600, windowMs: 5 * 60 * 1000 });
const commentLimiter = createLimiter({ name: "live-comment", limit: 20, windowMs: 60 * 1000 });

export const liveRouter = Router();
liveRouter.use(requireAuth);

const hostCutoff = () => new Date(Date.now() - HOST_STALE_MS);
const listenerCutoff = () => new Date(Date.now() - LISTENER_STALE_MS);
const isLive = (s) => s.status === "live" && s.lastHeartbeat > hostCutoff();
const validId = (id) => mongoose.isValidObjectId(id);

// Marks lives whose host stopped sending heartbeats as ended (and tidies up after them).
async function endStaleSessions() {
  const stale = await LiveSession.find({ status: "live", lastHeartbeat: { $lte: hostCutoff() } }).select("_id");
  if (!stale.length) return;
  const ids = stale.map((s) => s._id);
  await LiveSession.updateMany({ _id: { $in: ids } }, { $set: { status: "ended", endedAt: new Date(), expireAt: new Date(Date.now() + ENDED_KEEP_MS) } });
  await Promise.all([
    LiveListener.deleteMany({ session: { $in: ids } }),
    LiveSignal.deleteMany({ session: { $in: ids } }),
    removeLiveNotifications(ids),
  ]);
}

// "X is live" notifications are only useful while the live is on, so they go when it ends.
const removeLiveNotifications = (sessionIds) =>
  Notification.deleteMany({ type: "live_started", "payload.liveId": { $in: sessionIds.map(String) } });

// Tells the host's friends they've gone live. A failure here must never stop the live from starting.
async function notifyFriendsOfLive(session, hostId) {
  try {
    const friendships = await Friendship.find({ status: "accepted", $or: [{ requester: hostId }, { addressee: hostId }] });
    const friendIds = friendships.map((f) => (String(f.requester) === String(hostId) ? f.addressee : f.requester));
    if (!friendIds.length) return;
    await Notification.insertMany(
      friendIds.map((recipient) => ({
        recipient,
        type: "live_started",
        payload: { actorId: String(hostId), liveId: String(session._id), title: session.title },
      }))
    );
  } catch (err) {
    console.error("Couldn't notify friends of a live:", err.message);
  }
}

export async function endSession(session) {
  await LiveSession.updateOne(
    { _id: session._id },
    { $set: { status: "ended", endedAt: new Date(), expireAt: new Date(Date.now() + ENDED_KEEP_MS) } }
  );
  await Promise.all([
    LiveListener.deleteMany({ session: session._id }),
    LiveSignal.deleteMany({ session: session._id }),
    removeLiveNotifications([session._id]),
  ]);
}

async function listenerCount(sessionId) {
  return LiveListener.countDocuments({ session: sessionId, lastSeen: { $gt: listenerCutoff() } });
}

async function serializeSession(session, host, viewerId) {
  return {
    id: session._id,
    title: session.title,
    status: isLive(session) ? "live" : "ended",
    startedAt: session.createdAt,
    host: await toPublicUser(host, viewerId),
    isHost: String(session.host) === String(viewerId),
    listenerCount: await listenerCount(session._id),
    maxListeners: MAX_LISTENERS,
  };
}

// Loads a live room the viewer is allowed to see, or answers the error.
async function loadVisible(req, res) {
  if (!validId(req.params.id)) {
    res.status(404).json({ error: "Live not found" });
    return null;
  }
  const session = await LiveSession.findById(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Live not found" });
    return null;
  }
  const host = await User.findById(session.host);
  try {
    await assertVisible(host, req.user.id);
  } catch (err) {
    // Same answer as a missing room, so a blocked or private host's live can't be told apart from none.
    res.status(404).json({ error: "Live not found" });
    return null;
  }
  return { session, host };
}

// For the routes a room's members call every second or two (handshake messages, chat): being the host or a
// joined listener already proves they were allowed in, so these skip the heavier visibility checks.
// (Blocking someone removes them from the room straight away, see removeListenersBetween.)
async function loadMember(req, res) {
  if (!validId(req.params.id)) {
    res.status(404).json({ error: "Live not found" });
    return null;
  }
  const session = await LiveSession.findById(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Live not found" });
    return null;
  }
  if (!isLive(session)) {
    res.status(409).json({ error: "This live has ended" });
    return null;
  }
  const isHost = String(session.host) === String(req.user.id);
  if (!isHost && !(await LiveListener.findOne({ session: session._id, user: req.user.id, expireAt: { $gt: new Date() } }))) {
    res.status(403).json({ error: "Join this live first" });
    return null;
  }
  return { session, isHost };
}

// When one person blocks another, neither stays in the other's live.
export async function removeListenersBetween(idA, idB) {
  const sessions = await LiveSession.find({ host: { $in: [idA, idB] } }).select("_id host");
  for (const s of sessions) {
    const other = String(s.host) === String(idA) ? idB : idA;
    await Promise.all([
      LiveListener.deleteMany({ session: s._id, user: other }),
      LiveSignal.deleteMany({ session: s._id, $or: [{ from: other }, { to: other }] }),
    ]);
  }
}

const isHostOf = (session, userId) => String(session.host) === String(userId);
const listenerRow = (sessionId, userId) => LiveListener.findOne({ session: sessionId, user: userId, expireAt: { $gt: new Date() } });

// WebRTC needs to know which STUN/TURN servers to try. Defaults to free public STUN, which
// connects most people; LIVE_ICE_SERVERS (a JSON array) adds TURN relays for networks that need them.
const DEFAULT_ICE = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
function iceServers() {
  try {
    const parsed = JSON.parse(process.env.LIVE_ICE_SERVERS || "null");
    if (Array.isArray(parsed) && parsed.length && parsed.every((s) => s && typeof s === "object" && s.urls)) return parsed;
  } catch {
    // fall through to the default
  }
  return DEFAULT_ICE;
}

liveRouter.get("/ice", (req, res) => res.json({ iceServers: iceServers() }));

// Everyone live right now that the viewer may see: not blocked either way, and hosts
// with private profiles only to their friends (and themselves).
liveRouter.get("/", async (req, res) => {
  await endStaleSessions();
  const sessions = await LiveSession.find({ status: "live", lastHeartbeat: { $gt: hostCutoff() } }).sort("-createdAt").limit(50);
  const hosts = await User.find({ _id: { $in: sessions.map((s) => s.host) } });
  const hostById = new Map(hosts.map((h) => [String(h._id), h]));
  const blocked = await blockedUserIds(req.user.id);
  const friendships = await Friendship.find({
    status: "accepted",
    $or: [{ requester: req.user.id }, { addressee: req.user.id }],
  });
  const friendIds = new Set(friendships.map((f) => (String(f.requester) === req.user.id ? String(f.addressee) : String(f.requester))));

  const visible = sessions.filter((s) => {
    const host = hostById.get(String(s.host));
    if (!host || blocked.has(String(host._id))) return false;
    return !host.isPrivate || String(host._id) === req.user.id || friendIds.has(String(host._id));
  });
  res.json({ lives: await Promise.all(visible.map((s) => serializeSession(s, hostById.get(String(s.host)), req.user.id))) });
});

liveRouter.post("/", async (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!title) return res.status(400).json({ error: "Give your live a title" });
  if (title.length > 80) return res.status(400).json({ error: "Titles can be up to 80 characters" });
  if (!(await startLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(startLimiter.windowSeconds));
    return res.status(429).json({ error: "You've started a lot of lives — try again later." });
  }
  // One live per person: starting a new one ends any earlier one.
  for (const old of await LiveSession.find({ host: req.user.id, status: "live" })) await endSession(old);

  const session = await LiveSession.create({ host: req.user.id, title, lastHeartbeat: new Date() });
  const host = await User.findById(req.user.id);
  await notifyFriendsOfLive(session, req.user.id);
  res.status(201).json({ live: await serializeSession(session, host, req.user.id) });
});

liveRouter.get("/:id", async (req, res) => {
  const found = await loadVisible(req, res);
  if (!found) return;
  res.json({ live: await serializeSession(found.session, found.host, req.user.id) });
});

// Called every few seconds by the host (keeps the live alive) and by each listener
// (keeps them counted); either way the answer says whether the live is still on.
liveRouter.post("/:id/heartbeat", async (req, res) => {
  const found = await loadVisible(req, res);
  if (!found) return;
  const { session } = found;
  if (isHostOf(session, req.user.id)) {
    if (isLive(session)) await LiveSession.updateOne({ _id: session._id }, { $set: { lastHeartbeat: new Date() } });
  } else {
    const row = await listenerRow(session._id, req.user.id);
    if (!row) return res.status(403).json({ error: "Join this live first" });
    await LiveListener.updateOne({ _id: row._id }, { $set: { lastSeen: new Date(), expireAt: new Date(Date.now() + 10 * 60 * 1000) } });
  }
  const fresh = await LiveSession.findById(session._id);
  res.json({ status: isLive(fresh) ? "live" : "ended", listenerCount: await listenerCount(session._id) });
});

liveRouter.post("/:id/join", async (req, res) => {
  const found = await loadVisible(req, res);
  if (!found) return;
  const { session, host } = found;
  if (isHostOf(session, req.user.id)) return res.status(400).json({ error: "You're the host of this live" });
  if (!isLive(session)) return res.status(409).json({ error: "This live has ended" });
  if (!(await joinLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(joinLimiter.windowSeconds));
    return res.status(429).json({ error: "You're joining too often — try again later." });
  }
  const existing = await listenerRow(session._id, req.user.id);
  if (!existing && (await listenerCount(session._id)) >= MAX_LISTENERS) {
    return res.status(409).json({ error: `This live is full (${MAX_LISTENERS} listeners)` });
  }
  const now = Date.now();
  await LiveListener.updateOne(
    { session: session._id, user: req.user.id },
    { $set: { lastSeen: new Date(now), expireAt: new Date(now + 10 * 60 * 1000) } },
    { upsert: true }
  );
  res.status(200).json({ live: await serializeSession(session, host, req.user.id) });
});

liveRouter.post("/:id/leave", async (req, res) => {
  if (!validId(req.params.id)) return res.status(204).end();
  await Promise.all([
    LiveListener.deleteOne({ session: req.params.id, user: req.user.id }),
    LiveSignal.deleteMany({ session: req.params.id, $or: [{ from: req.user.id }, { to: req.user.id }] }),
  ]);
  res.status(204).end();
});

liveRouter.post("/:id/end", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Live not found" });
  const session = await LiveSession.findOne({ _id: req.params.id, host: req.user.id });
  if (!session) return res.status(404).json({ error: "Live not found" });
  await endSession(session);
  res.status(204).end();
});

// ---- WebRTC handshake messages ---------------------------------------------
// A listener sends an offer to the host; the host answers; both then trade ICE
// candidates. Each message goes to exactly one person and is deleted a few minutes later.
liveRouter.post("/:id/signals", async (req, res) => {
  const found = await loadMember(req, res);
  if (!found) return;
  const { session } = found;
  if (!isLive(session)) return res.status(409).json({ error: "This live has ended" });

  const { to, kind, data } = req.body ?? {};
  if (!["offer", "answer", "ice"].includes(kind) || !data || typeof data !== "object" || typeof to !== "string" || !validId(to)) {
    return res.status(400).json({ error: "Invalid signal" });
  }
  if (JSON.stringify(data).length > MAX_SIGNAL_BYTES) return res.status(400).json({ error: "Signal too large" });

  const fromHost = isHostOf(session, req.user.id);
  if (fromHost) {
    // the host can only talk to people who are listening
    if (!(await listenerRow(session._id, to))) return res.status(404).json({ error: "That listener isn't here" });
  } else {
    // a listener can only talk to the host, and only once they've joined
    if (to !== String(session.host)) return res.status(403).json({ error: "Not allowed" });
  }
  if (!(await signalLimiter.allow(req.user.id))) return res.status(429).json({ error: "Too many requests — slow down." });

  await LiveSignal.create({ session: session._id, from: req.user.id, to, kind, data, expireAt: new Date(Date.now() + SIGNAL_TTL_MS) });
  res.status(201).json({ ok: true });
});

liveRouter.get("/:id/signals", async (req, res) => {
  const found = await loadMember(req, res);
  if (!found) return;
  const { session } = found;
  const filter = { session: session._id, to: req.user.id };
  if (typeof req.query.after === "string" && validId(req.query.after)) filter._id = { $gt: req.query.after };
  const signals = await LiveSignal.find(filter).sort({ _id: 1 }).limit(100);
  res.json({ signals: signals.map((s) => ({ id: s._id, from: s.from, kind: s.kind, data: s.data })) });
});

// ---- Live chat --------------------------------------------------------------
async function toComments(comments, viewerId) {
  const users = await User.find({ _id: { $in: [...new Set(comments.map((c) => String(c.user)))] } });
  const byId = new Map();
  for (const u of users) byId.set(String(u._id), await toPublicUser(u, viewerId));
  return comments.map((c) => ({
    id: c._id,
    userId: c.user,
    user: byId.get(String(c.user)) ?? null,
    mine: String(c.user) === String(viewerId),
    body: c.body,
    createdAt: c.createdAt,
  }));
}

liveRouter.get("/:id/comments", async (req, res) => {
  const found = await loadMember(req, res);
  if (!found) return;
  const { session } = found;
  const blocked = await blockedUserIds(req.user.id);
  const filter = { session: session._id, user: { $nin: [...blocked] } };
  let comments;
  if (typeof req.query.after === "string" && validId(req.query.after)) {
    filter._id = { $gt: req.query.after };
    comments = await LiveComment.find(filter).sort({ _id: 1 }).limit(100);
  } else {
    comments = (await LiveComment.find(filter).sort({ _id: -1 }).limit(COMMENT_PAGE)).reverse();
  }
  res.json({ comments: await toComments(comments, req.user.id) });
});

liveRouter.post("/:id/comments", async (req, res) => {
  const found = await loadMember(req, res);
  if (!found) return;
  const { session } = found;
  if (!isLive(session)) return res.status(409).json({ error: "This live has ended" });
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) return res.status(400).json({ error: "Write something to send" });
  if (body.length > MAX_COMMENT_LENGTH) return res.status(400).json({ error: `Comments can be up to ${MAX_COMMENT_LENGTH} characters` });
  if (!(await commentLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(commentLimiter.windowSeconds));
    return res.status(429).json({ error: "You're commenting too fast — wait a moment." });
  }
  const comment = await LiveComment.create({ session: session._id, user: req.user.id, body, expireAt: new Date(Date.now() + COMMENT_TTL_MS) });
  const [out] = await toComments([comment], req.user.id);
  res.status(201).json({ comment: out });
});

// The author or the host can remove a comment.
liveRouter.delete("/:id/comments/:commentId", async (req, res) => {
  const found = await loadVisible(req, res);
  if (!found) return;
  if (!validId(req.params.commentId)) return res.status(404).json({ error: "Comment not found" });
  const comment = await LiveComment.findOne({ _id: req.params.commentId, session: found.session._id });
  const allowed = comment && (String(comment.user) === req.user.id || isHostOf(found.session, req.user.id));
  if (!allowed) return res.status(404).json({ error: "Comment not found" });
  await comment.deleteOne();
  res.status(204).end();
});
