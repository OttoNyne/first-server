import webpush from "web-push";
import { PushSubscription } from "../models/PushSubscription.js";
import { User } from "../models/User.js";
import { createLimiter } from "../utils/rateLimit.js";
import { categoryOf } from "../utils/pushInput.js";
import { emojiOf } from "../utils/reactionKeys.js";

// Push notifications: when someone gets a notification (the bell), the devices they have turned notifications on for get a message too,
// even with the site closed. Everything here is best effort and never stops the thing that caused the notification.
//
// What a push says is deliberately little: who it is from and what they did, never what they wrote, because it shows on a lock screen.
// Each device is sent to only if the person has that kind switched on, the account isn't suspended, and no more than 30 an hour go to
// one person (the bell still has everything).
//
// Turned on by setting VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (a mailto: or https address that says who is sending);
// without them nothing is sent and the site says notifications aren't available.

const TITLE = "CreativesSelect";
const MAX_PER_HOUR = 30;
const SEND_AT_ONCE = 20;
const pushLimiter = createLimiter({ name: "push-to-person", limit: MAX_PER_HOUR, windowMs: 60 * 60 * 1000 });

let configured = { key: "", publicKey: null };
/** The public key devices subscribe with, or null when push isn't set up (or the keys aren't usable). */
export function pushPublicKey() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  const key = `${publicKey}|${privateKey}|${subject}`;
  if (configured.key !== key) {
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      configured = { key, publicKey };
    } catch (err) {
      console.error("Push notifications are switched off: the VAPID settings aren't usable:", err.message);
      configured = { key, publicKey: null };
    }
  }
  return configured.publicKey;
}
export const isPushEnabled = () => Boolean(pushPublicKey());

const named = (user) => (user?.displayName ? String(user.displayName).replace(/\s+/g, " ").slice(0, 40) : "Someone");

/** What to show and where to go for a notification: { body, url, tag }. Names the other person, never what they wrote. */
export function describePush(n, actor, recipient) {
  const who = named(actor);
  const p = n.payload ?? {};
  const mine = recipient?.username ? `/u/${recipient.username}` : "/";
  const theirs = actor?.username ? `/u/${actor.username}` : "/";
  const id = (value) => (value ? encodeURIComponent(String(value)) : "");
  switch (n.type) {
    case "message": {
      const count = Number(p.count) > 1 ? `${Math.min(Number(p.count), 99)} messages` : "a message";
      return { body: `${who} sent you ${count}`, url: actor?.username ? `/messages/${actor.username}` : "/messages", tag: `message-${id(p.actorId)}` };
    }
    case "friend_request":
      return { body: `${who} sent you a friend request`, url: "/friends" };
    case "friend_accept":
      return { body: `${who} accepted your friend request`, url: theirs };
    case "invite_joined":
      return { body: `${who} joined with your invite link`, url: "/friends" };
    case "group_invite":
      return { body: `${who} invited you to a group`, url: p.groupId ? `/groups/${id(p.groupId)}` : "/groups" };
    case "friend_birthday":
      return { body: `${who} has a birthday today`, url: theirs };
    case "comment":
      return { body: `${who} commented on your post`, url: p.postId ? `/posts/${id(p.postId)}` : "/" };
    case "profile_comment":
      return { body: `${who} left a comment on your profile`, url: `${mine}#testimonials` };
    case "media_comment":
      return { body: `${who} commented on your portfolio`, url: `${mine}#portfolio` };
    case "blog_comment":
      return { body: `${who} commented on your blog entry`, url: p.entryId ? `/blog/${id(p.entryId)}` : "/" };
    case "reaction": {
      const mark = emojiOf(p.emoji);
      return p.targetType === "post"
        ? { body: `${who} reacted ${mark} to your post`, url: p.targetId ? `/posts/${id(p.targetId)}` : "/" }
        : { body: `${who} reacted ${mark} to your portfolio`, url: p.targetId ? `${mine}?piece=${id(p.targetId)}#portfolio` : `${mine}#portfolio` };
    }
    case "event_created":
      return { body: `${who} is planning an event`, url: p.eventId ? `/events/${id(p.eventId)}` : "/events" };
    case "event_updated":
      return { body: `${who} changed an event you answered`, url: p.eventId ? `/events/${id(p.eventId)}` : "/events" };
    case "event_cancelled":
      return { body: `${who} cancelled an event`, url: "/events" };
    case "event_reminder":
      return { body: "An event you're going to is starting soon", url: p.eventId ? `/events/${id(p.eventId)}` : "/events" };
    case "live_scheduled":
      return { body: `${who} scheduled a live`, url: "/live" };
    case "live_reminder":
      return { body: "A live you asked about is starting soon", url: "/live" };
    case "live_started":
      return { body: `${who} is live now`, url: p.liveId ? `/live/${id(p.liveId)}` : "/live" };
    case "blog_post":
      return { body: `${who} wrote a blog entry`, url: p.entryId ? `/blog/${id(p.entryId)}` : "/" };
    case "help_offer":
      return { body: `${who} offered to help with your request`, url: "/help-wanted" };
    case "help_accepted":
      return { body: `${who} accepted your offer to help`, url: "/help-wanted" };
    case "report_resolved":
      return { body: "A moderator looked at your report", url: "/" };
    case "content_removed":
      return { body: "A moderator removed something you posted", url: "/" };
    case "cs_verified":
      return { body: "You're now CSverified", url: mine };
    default:
      return null;
  }
}

async function sendOne(sub, message, options = {}) {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(message), { TTL: 24 * 60 * 60, timeout: 10_000, ...options });
    return true;
  } catch (err) {
    // the browser says the device is gone (uninstalled, permission taken away, expired): forget it
    if (err?.statusCode === 404 || err?.statusCode === 410) await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
    else console.error(`Couldn't send a push (${err?.statusCode ?? "no answer"}):`, String(err?.body ?? err?.message ?? err).slice(0, 120));
    return false;
  }
}

async function sendAll(jobs) {
  for (let i = 0; i < jobs.length; i += SEND_AT_ONCE) await Promise.allSettled(jobs.slice(i, i + SEND_AT_ONCE).map((job) => sendOne(...job)));
}

async function deliver(notifications) {
  const recipientIds = [...new Set(notifications.map((n) => String(n.recipient)))];
  const subs = await PushSubscription.find({ user: { $in: recipientIds } });
  if (!subs.length) return; // most people: nothing to do
  const subsOf = new Map();
  for (const s of subs) subsOf.set(String(s.user), [...(subsOf.get(String(s.user)) ?? []), s]);
  const [recipients, actors] = await Promise.all([
    User.find({ _id: { $in: [...subsOf.keys()] } }).select("username suspendedAt pushPrefs"),
    User.find({ _id: { $in: [...new Set(notifications.map((n) => n.payload?.actorId).filter(Boolean))] } }).select("username displayName"),
  ]);
  const recipientOf = new Map(recipients.map((u) => [String(u._id), u]));
  const actorOf = new Map(actors.map((u) => [String(u._id), u]));

  const jobs = [];
  for (const n of notifications) {
    const who = String(n.recipient);
    const person = recipientOf.get(who);
    const category = categoryOf(n.type);
    if (!person || person.suspendedAt || !category || !subsOf.has(who)) continue;
    if (person.pushPrefs?.[category] === false) continue;
    const text = describePush(n, actorOf.get(String(n.payload?.actorId)), person);
    if (!text || !(await pushLimiter.allow(who))) continue;
    const message = { title: TITLE, body: text.body, url: text.url, tag: text.tag ?? `n-${n._id}` };
    for (const sub of subsOf.get(who)) jobs.push([sub, message]);
  }
  await sendAll(jobs);
}

const inFlight = new Set();
/** Tell the devices of whoever these notifications are for. Doesn't wait, and never throws. */
export function queuePush(notifications) {
  if (!isPushEnabled() || !notifications?.length) return;
  const work = deliver(notifications)
    .catch((err) => console.error("Couldn't send push notifications:", err.message))
    .finally(() => inFlight.delete(work));
  inFlight.add(work);
}
/** Resolves when every push started so far has been tried (for tests). */
export async function settlePushes() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/** A test message to all of one person's devices; returns how many accepted it. */
export async function sendTestPush(userId) {
  const subs = await PushSubscription.find({ user: userId });
  const results = await Promise.all(subs.map((sub) => sendOne(sub, { title: TITLE, body: "Notifications are working on this device", url: "/", tag: "test" })));
  return results.filter(Boolean).length;
}
