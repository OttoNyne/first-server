import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { Follow } from "../models/Follow.js";
import { Notification } from "../models/Notification.js";
import { Friendship } from "../models/Friendship.js";
import { Project } from "../models/Project.js";
import { ProjectMessage } from "../models/ProjectMessage.js";
import { Call } from "../models/Call.js";
import { Post } from "../models/Post.js";
import { MediaItem } from "../models/MediaItem.js";
import { TagFollow } from "../models/TagFollow.js";
import { sendMail, mailAvailable } from "../utils/mailer.js";
import { emailFor } from "../utils/emailText.js";
import { primaryClientUrl } from "../utils/origins.js";
import { blockedUserIds } from "../utils/visibility.js";
import { mutedUserIds } from "../utils/mutes.js";
import { matchedRoles } from "../utils/calls.js";

// The weekly summary: an email, for people who turned it on, of what happened since the last one (or since they turned it on): new followers,
// comments and replies, answers waiting, what is new in their project rooms, open calls that fit what they offer, and what has been posted
// about the topics they follow. Nothing is sent when there is nothing to say, and the email says only counts and titles, never anyone's words.
export const EVERY_MS = 7 * 24 * 60 * 60 * 1000;
export const RETRY_MS = 3 * 24 * 60 * 60 * 1000; // when there was nothing to say, look again sooner
export const PER_RUN = 25;
const ACTIVITY = ["comment", "reply", "media_comment", "blog_comment", "profile_comment", "mention"];

/** The link in the email that turns it off: carries who it is for, proven by the site's signature, so it works without signing in. */
export function unsubscribeToken(userId) {
  return jwt.sign({ purpose: "digest-off", sub: String(userId) }, process.env.JWT_SECRET, { expiresIn: "400d" });
}

/** Who a token turns the summary off for, or null for one that is forged, old or for something else. */
export function readUnsubscribeToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload.purpose === "digest-off" && typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** What the summary would say for this person since a date. `empty` is true when there is nothing worth an email. */
export async function buildDigest(user, since) {
  const id = user._id;
  const [blocked, muted] = await Promise.all([blockedUserIds(id), mutedUserIds(id)]);
  const unwanted = [...new Set([...blocked, ...muted])];

  const [followers, activity, requests] = await Promise.all([
    Follow.countDocuments({ following: id, follower: { $nin: unwanted }, createdAt: { $gt: since } }),
    Notification.countDocuments({ recipient: id, type: { $in: ACTIVITY }, "payload.actorId": { $nin: unwanted }, createdAt: { $gt: since } }),
    Friendship.countDocuments({ addressee: id, status: "pending" }),
  ]);

  let roomsUnread = 0;
  for (const room of await Project.find({ members: id, status: "active" }).select("reads").limit(50)) {
    const readAt = room.reads.find((r) => String(r.user) === String(id))?.at ?? new Date(0);
    roomsUnread += await ProjectMessage.countDocuments({ project: room._id, author: { $ne: id, $nin: unwanted }, createdAt: { $gt: readAt } });
  }

  const recentCalls = await Call.find({ status: "open", owner: { $nin: [id, ...unwanted] }, createdAt: { $gt: since } })
    .sort({ _id: -1 })
    .limit(60)
    .populate("owner", "isPrivate suspendedAt");
  const calls = recentCalls
    .filter((c) => c.owner && !c.owner.isPrivate && !c.owner.suspendedAt && matchedRoles(c.lookingFor, user).length > 0)
    .slice(0, 3)
    .map((c) => ({ id: String(c._id), title: c.title }));

  const topics = [];
  for (const row of (await TagFollow.find({ user: id }).sort({ _id: -1 }).limit(10).select("tag").lean())) {
    const [posts, pieces] = await Promise.all([
      Post.find({ tags: row.tag, createdAt: { $gt: since }, author: { $nin: [id, ...unwanted] } }).limit(100).populate("author", "isPrivate suspendedAt"),
      MediaItem.find({ tags: row.tag, createdAt: { $gt: since }, owner: { $nin: [id, ...unwanted] } }).limit(100).populate("owner", "isPrivate suspendedAt"),
    ]);
    const open = (p) => p && !p.isPrivate && !p.suspendedAt;
    const n = posts.filter((p) => open(p.author)).length + pieces.filter((p) => open(p.owner)).length;
    if (n > 0) topics.push({ tag: row.tag, n });
  }
  topics.sort((a, b) => b.n - a.n);

  const digest = { followers, activity, requests, roomsUnread, calls, topics: topics.slice(0, 5) };
  digest.empty = followers + activity + requests + roomsUnread + calls.length + digest.topics.length === 0;
  return digest;
}

/**
 * Sends the summaries that are due: to people who turned it on, whose address is confirmed, who aren't suspended, and whose next one is due.
 * At most `limit` a run. Each person is claimed before anything is built, so two runs at once can't send one twice. When there is nothing to
 * say nothing is sent and the next look comes sooner. Returns how many were sent.
 */
export async function runDigests({ now = new Date(), limit = PER_RUN } = {}) {
  if (!mailAvailable()) return { sent: 0, looked: 0 };
  const base = process.env.CLIENT_URL ? primaryClientUrl() : "http://localhost:5173";
  const due = await User.find({ weeklyDigest: true, emailVerified: true, suspendedAt: null, digestNextAt: { $lte: now } }).sort({ digestNextAt: 1 }).limit(limit).select("_id");
  let sent = 0;
  let looked = 0;
  for (const { _id } of due) {
    const user = await User.findOneAndUpdate({ _id, weeklyDigest: true, digestNextAt: { $lte: now } }, { $set: { digestNextAt: new Date(now.getTime() + RETRY_MS) } }, { new: false });
    if (!user) continue; // someone else got there first, or they turned it off
    looked += 1;
    try {
      const since = user.digestSinceAt ?? new Date(now.getTime() - EVERY_MS);
      const digest = await buildDigest(user, since);
      if (digest.empty) continue;
      const mail = emailFor("weeklyDigest", user, {
        name: user.displayName,
        ...digest,
        site: base,
        topicsLink: `${base}/explore?mine=1`,
        callsLink: `${base}/calls`,
        roomsLink: `${base}/projects`,
        unsubscribe: `${base}/digest/unsubscribe#token=${unsubscribeToken(user._id)}`,
      });
      const result = await sendMail({ to: user.email, ...mail });
      if (result.sent) {
        sent += 1;
        await User.updateOne({ _id: user._id }, { $set: { digestSinceAt: now, digestNextAt: new Date(now.getTime() + EVERY_MS) } });
      }
    } catch (err) {
      console.error("Couldn't make a summary:", err.message);
    }
  }
  return { sent, looked };
}
