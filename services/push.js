import webpush from "web-push";
import { PushSubscription } from "../models/PushSubscription.js";
import { User } from "../models/User.js";
import { Mute } from "../models/Mute.js";
import { createLimiter } from "../utils/rateLimit.js";
import { categoryOf } from "../utils/pushInput.js";
import { emojiOf } from "../utils/reactionKeys.js";
import { pushBody } from "../utils/pushText.js";
import { languageOf } from "../utils/languages.js";
import { isSitePath } from "../utils/mentions.js";

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

const SOMEONE = { en: "Someone", es: "Alguien", ar: "شخص ما" };
const named = (user, recipient) => (user?.displayName ? String(user.displayName).replace(/\s+/g, " ").slice(0, 40) : SOMEONE[languageOf(recipient)]);

/** What to show and where to go for a notification: { body, url, tag }. Names the other person, never what they wrote. */
export function describePush(n, actor, recipient) {
  const who = named(actor, recipient);
  const p = n.payload ?? {};
  const mine = recipient?.username ? `/u/${recipient.username}` : "/";
  const theirs = actor?.username ? `/u/${actor.username}` : "/";
  const id = (value) => (value ? encodeURIComponent(String(value)) : "");
  const say = (kind, params = {}) => pushBody(kind, recipient, { who, ...params });
  switch (n.type) {
    case "message": {
      const count = Number(p.count) > 1 ? Math.min(Number(p.count), 99) : 1;
      return { body: say("message", { count }), url: actor?.username ? `/messages/${actor.username}` : "/messages", tag: `message-${id(p.actorId)}` };
    }
    case "friend_request":
      return { body: say("friend_request"), url: "/friends" };
    case "friend_accept":
      return { body: say("friend_accept"), url: theirs };
    case "invite_joined":
      return { body: say("invite_joined"), url: "/friends" };
    case "group_invite":
      return { body: say("group_invite"), url: p.groupId ? `/groups/${id(p.groupId)}` : "/groups" };
    case "friend_birthday":
      return { body: say("friend_birthday"), url: theirs };
    case "comment":
      return { body: say("comment"), url: p.postId ? `/posts/${id(p.postId)}` : "/" };
    case "profile_comment":
      return { body: say("profile_comment"), url: `${mine}#testimonials` };
    case "media_comment":
      return { body: say("media_comment"), url: `${mine}#portfolio` };
    case "blog_comment":
      return { body: say("blog_comment"), url: p.entryId ? `/blog/${id(p.entryId)}` : "/" };
    case "reaction": {
      const mark = emojiOf(p.emoji);
      return p.targetType === "post"
        ? { body: say("reaction_post", { mark }), url: p.targetId ? `/posts/${id(p.targetId)}` : "/" }
        : { body: say("reaction_portfolio", { mark }), url: p.targetId ? `${mine}?piece=${id(p.targetId)}#portfolio` : `${mine}#portfolio` };
    }
    case "event_created":
      return { body: say("event_created"), url: p.eventId ? `/events/${id(p.eventId)}` : "/events" };
    case "event_updated":
      return { body: say("event_updated"), url: p.eventId ? `/events/${id(p.eventId)}` : "/events" };
    case "event_cancelled":
      return { body: say("event_cancelled"), url: "/events" };
    case "event_reminder":
      return { body: say("event_reminder"), url: p.eventId ? `/events/${id(p.eventId)}` : "/events" };
    case "live_scheduled":
      return { body: say("live_scheduled"), url: "/live" };
    case "live_reminder":
      return { body: say("live_reminder"), url: "/live" };
    case "live_started":
      return { body: say("live_started"), url: p.liveId ? `/live/${id(p.liveId)}` : "/live" };
    case "blog_post":
      return { body: say("blog_post"), url: p.entryId ? `/blog/${id(p.entryId)}` : "/" };
    case "help_offer":
      return { body: say("help_offer"), url: "/help-wanted" };
    case "help_accepted":
      return { body: say("help_accepted"), url: "/help-wanted" };
    case "report_resolved":
      return { body: say("report_resolved"), url: "/" };
    case "content_removed":
      return { body: say("content_removed"), url: "/" };
    case "credit_request":
      return { body: say("credit_request"), url: `${mine}#portfolio` };
    case "credit_accepted":
      return { body: say("credit_accepted"), url: p.itemId ? `${mine}?piece=${id(p.itemId)}#portfolio` : `${mine}#portfolio` };
    case "work_request":
      return { body: say("work_request"), url: `${mine}#work` };
    case "work_reply":
      return { body: say("work_reply"), url: `${mine}#work` };
    case "critique_note":
    case "critique_thanks":
      return { body: say(n.type), url: p.critiqueId ? `/critiques/${id(p.critiqueId)}` : "/critiques" };
    case "project_message":
      return { body: say("project_message"), url: p.projectId ? `/projects/${id(p.projectId)}` : "/projects", tag: `project-${id(p.projectId)}` };
    case "call_match":
    case "call_application":
    case "call_answer":
      return { body: say(n.type), url: p.callId ? `/calls/${id(p.callId)}` : "/calls" };
    case "reply":
      return { body: say("reply"), url: isSitePath(p.url) ? p.url : "/" };
    case "repost":
      return { body: say("repost"), url: p.postId ? `/posts/${id(p.postId)}` : "/" };
    case "follow":
      return { body: say("follow"), url: theirs };
    case "mention":
      return { body: say("mention"), url: isSitePath(p.url) ? p.url : "/" };
    case "cs_verified":
      return { body: say("cs_verified"), url: mine };
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
    User.find({ _id: { $in: [...subsOf.keys()] } }).select("username suspendedAt pushPrefs language"),
    User.find({ _id: { $in: [...new Set(notifications.map((n) => n.payload?.actorId).filter(Boolean))] } }).select("username displayName"),
  ]);
  const recipientOf = new Map(recipients.map((u) => [String(u._id), u]));
  const actorOf = new Map(actors.map((u) => [String(u._id), u]));

  // people who muted the one it is about hear nothing of it
  const muting = new Set((await Mute.find({ user: { $in: [...subsOf.keys()] }, muted: { $in: [...actorOf.keys()] } }).select("user muted").lean()).map((m) => `${m.user}:${m.muted}`));

  const jobs = [];
  for (const n of notifications) {
    const who = String(n.recipient);
    if (muting.has(`${who}:${n.payload?.actorId}`)) continue;
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
  const [subs, person] = await Promise.all([PushSubscription.find({ user: userId }), User.findById(userId).select("language")]);
  const body = pushBody("test", person);
  const results = await Promise.all(subs.map((sub) => sendOne(sub, { title: TITLE, body, url: "/", tag: "test" })));
  return results.filter(Boolean).length;
}
