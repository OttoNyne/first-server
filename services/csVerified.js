import { User } from "../models/User.js";
import { Friendship } from "../models/Friendship.js";
import { Notification } from "../models/Notification.js";
import { friendIdsOf } from "../utils/friendGraph.js";

// The CSverified badge: shown on a profile when an administrator has given it, or when the person has earned it by having 1,000 active
// friends. The two are kept apart (csVerifiedByAdmin and csVerifiedEarned on the user), so taking one away never takes the other.
//
// An "active friend" is an accepted friend whose account is not suspended, whose email is confirmed, and who was seen in the last 30
// days. Someone who has chosen not to share when they are active (see utils/activity.js) is never counted as active: the app forgets
// when they were last around, and this deliberately doesn't keep a second, hidden record to count them with.
//
// A badge that was earned is kept until the number falls below 900, not 1,000, so a few friends going quiet doesn't make it come and go.

export const EARN_AT = 1000;
export const KEEP_AT = 900;
export const ACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a user shows the badge (either way). */
export const isCsVerified = (user) => Boolean(user && (user.csVerifiedByAdmin || user.csVerifiedEarned));

/** How many of a person's friends are active: confirmed, not suspended, and seen in the last 30 days. */
export async function activeFriendCount(userId, now = new Date()) {
  const friends = [...(await friendIdsOf(userId))];
  if (!friends.length) return 0;
  return User.countDocuments({ _id: { $in: friends }, suspendedAt: null, emailVerified: true, lastActiveAt: { $gte: new Date(now.getTime() - ACTIVE_DAYS * DAY_MS) } });
}

async function tell(userId, reason) {
  try {
    await Notification.create({ recipient: userId, type: "cs_verified", payload: { reason } });
  } catch (err) {
    console.error("Couldn't send the CSverified note:", err.message);
  }
}

/** Works out whether a person has earned (or no longer keeps) the badge, and records it. Returns "earned", "lost" or null. */
export async function evaluateEarned(userId, now = new Date()) {
  const user = await User.findById(userId);
  if (!user || user.suspendedAt) return null;
  const count = await activeFriendCount(userId, now);
  if (!user.csVerifiedEarned && count >= EARN_AT) {
    // one atomic update, so two checks at once can't both announce it
    const won = await User.findOneAndUpdate({ _id: userId, csVerifiedEarned: { $ne: true } }, { $set: { csVerifiedEarned: true, csVerifiedEarnedAt: now } });
    if (!won) return null;
    if (!won.csVerifiedByAdmin) await tell(userId, "friends"); // already showing it? then nothing new to tell
    return "earned";
  }
  if (user.csVerifiedEarned && count < KEEP_AT) {
    await User.updateOne({ _id: userId }, { $set: { csVerifiedEarned: false, csVerifiedEarnedAt: null } });
    return "lost";
  }
  return null;
}

/** Everyone who might have earned it, or might have lost it: people with at least 900 friends, and people who currently hold an earned badge. */
export async function candidates() {
  const many = await Friendship.aggregate([
    { $match: { status: "accepted" } },
    { $project: { ends: ["$requester", "$addressee"] } },
    { $unwind: "$ends" },
    { $group: { _id: "$ends", friends: { $sum: 1 } } },
    { $match: { friends: { $gte: KEEP_AT } } },
  ]);
  const holders = await User.find({ csVerifiedEarned: true }).select("_id");
  return [...new Set([...many.map((m) => String(m._id)), ...holders.map((h) => String(h._id))])];
}

let lastRun = 0;
const RUN_EVERY_MS = 6 * 60 * 60 * 1000;

/** Checks everyone who might have earned or lost the badge. Without `at`, runs at most once every six hours. Returns { earned, lost }. */
export async function processCsVerified(at) {
  if (!at) {
    if (Date.now() - lastRun < RUN_EVERY_MS) return { earned: 0, lost: 0 };
    lastRun = Date.now();
  }
  const now = at ?? new Date();
  const result = { earned: 0, lost: 0 };
  for (const id of await candidates()) {
    try {
      const change = await evaluateEarned(id, now);
      if (change === "earned") result.earned += 1;
      if (change === "lost") result.lost += 1;
    } catch (err) {
      console.error("CSverified check failed for one person:", err.message);
    }
  }
  return result;
}

/** Gives an administrator's badge. Returns true if it was newly given. */
export async function giveByAdmin(user, now = new Date()) {
  if (user.csVerifiedByAdmin) return false;
  const showedBefore = isCsVerified(user);
  // one atomic update, so two administrators at once can't both give it (or both announce it)
  const done = await User.updateOne({ _id: user._id, csVerifiedByAdmin: { $ne: true } }, { $set: { csVerifiedByAdmin: true, csVerifiedAdminAt: now } });
  if (!done.modifiedCount) return false;
  user.csVerifiedByAdmin = true;
  user.csVerifiedAdminAt = now;
  if (!showedBefore) await tell(user._id, "admin");
  return true;
}

/** Takes an administrator's badge away (an earned one is not touched). Returns true if there was one to take. */
export async function removeByAdmin(user) {
  if (!user.csVerifiedByAdmin) return false;
  const done = await User.updateOne({ _id: user._id, csVerifiedByAdmin: true }, { $set: { csVerifiedByAdmin: false, csVerifiedAdminAt: null } });
  if (!done.modifiedCount) return false;
  user.csVerifiedByAdmin = false;
  user.csVerifiedAdminAt = null;
  return true;
}

// Runs the check every half hour for the life of the server (the real work happens at most every six hours; not started by tests).
export function startCsVerifiedTimer(everyMs = 30 * 60 * 1000) {
  const timer = setInterval(() => {
    processCsVerified().catch((err) => console.error("CSverified check failed:", err.message));
  }, everyMs);
  timer.unref?.();
  return timer;
}
