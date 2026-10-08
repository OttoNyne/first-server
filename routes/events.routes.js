import { Router } from "express";
import { notifyMentions } from "../services/mentions.js";
import mongoose from "mongoose";
import { Event } from "../models/Event.js";
import { EventRsvp } from "../models/EventRsvp.js";
import { User } from "../models/User.js";
import { Friendship } from "../models/Friendship.js";
import { Notification } from "../models/Notification.js";
import { requireAuth } from "../middleware/auth.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import { blockedUserIds } from "../utils/visibility.js";
import { toPublicUser } from "../utils/serialize.js";
import { checkEvent } from "../utils/eventInput.js";
import { allowEdit } from "../utils/textInput.js";
import { createLimiter } from "../utils/rateLimit.js";
import { SHOW_AFTER_START_MS, eventOverAt, eventPayload, expiryOf, guestIds, processDueEventReminders, removeEventNotifications } from "../services/events.js";

// Events: something a person is organising. Friends are told, anyone who can see it says going or maybe, and the people who did
// are reminded before it starts. Who can see an event is decided in one place (`canSee`), and an event that can't be seen is the
// same 404 as one that doesn't exist.
export const eventsRouter = Router();
eventsRouter.use(requireAuth);

const PAGE = 20;
const MAX_PAGE = 25;
const SCAN = 300; // how many upcoming events are looked through to fill a page of what the viewer may see
const GUESTS_PAGE = 50;
const MAX_UPCOMING_PER_HOST = 10;

const createEventLimiter = createLimiter({ name: "event-create", limit: 10, windowMs: 60 * 60 * 1000 });
const rsvpLimiter = createLimiter({ name: "event-rsvp", limit: 120, windowMs: 60 * 60 * 1000 });
const validId = (id) => mongoose.isValidObjectId(id);

/** Events that have not ended (or, with no end time, began within the last few hours). */
const notOver = () => {
  const now = new Date();
  return { $or: [{ endsAt: { $gt: now } }, { endsAt: null, startsAt: { $gt: new Date(now.getTime() - SHOW_AFTER_START_MS) } }] };
};

async function friendIdsOf(userId) {
  const friendships = await Friendship.find({ status: "accepted", $or: [{ requester: userId }, { addressee: userId }] });
  return new Set(friendships.map((f) => (String(f.requester) === String(userId) ? String(f.addressee) : String(f.requester))));
}

/**
 * The events (of the ones given) the viewer may see: their own; otherwise the host must not be suspended or blocked either way, and
 * for a friends-only event must be a friend, while a public event is visible to anyone unless the host's profile is private.
 */
async function canSee(events, viewerId) {
  if (!events.length) return [];
  const hosts = await User.find({ _id: { $in: [...new Set(events.map((e) => String(e.host)))] } });
  const hostById = new Map(hosts.map((h) => [String(h._id), h]));
  const [blocked, friends] = await Promise.all([blockedUserIds(viewerId), friendIdsOf(viewerId)]);
  return events.filter((e) => {
    const host = hostById.get(String(e.host));
    if (!host) return false;
    if (String(host._id) === String(viewerId)) return true;
    if (host.suspendedAt || blocked.has(String(host._id))) return false;
    if (e.audience === "friends") return friends.has(String(host._id));
    return !host.isPrivate || friends.has(String(host._id));
  });
}

async function loadVisible(req, res) {
  if (!validId(req.params.id)) return void res.status(404).json({ error: "Event not found" });
  const event = await Event.findById(req.params.id);
  if (!event || !(await canSee([event], req.user.id)).length) return void res.status(404).json({ error: "Event not found" });
  return event;
}

async function serialize(events, viewerId) {
  if (!events.length) return [];
  const ids = events.map((e) => e._id);
  const [hosts, counts, mine] = await Promise.all([
    User.find({ _id: { $in: [...new Set(events.map((e) => String(e.host)))] } }),
    EventRsvp.aggregate([{ $match: { event: { $in: ids } } }, { $group: { _id: { event: "$event", status: "$status" }, n: { $sum: 1 } } }]),
    EventRsvp.find({ event: { $in: ids }, user: viewerId }),
  ]);
  const hostById = new Map(hosts.map((h) => [String(h._id), h]));
  const count = new Map(counts.map((c) => [`${c._id.event}:${c._id.status}`, c.n]));
  const myStatus = new Map(mine.map((r) => [String(r.event), r.status]));
  return Promise.all(
    events.map(async (e) => ({
      id: e._id,
      title: e.title,
      description: e.description,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      kind: e.kind,
      place: e.place,
      link: e.link,
      audience: e.audience,
      editedAt: e.editedAt ?? null,
      host: await toPublicUser(hostById.get(String(e.host)), viewerId),
      isHost: String(e.host) === String(viewerId),
      myStatus: myStatus.get(String(e._id)) ?? null,
      goingCount: count.get(`${e._id}:going`) ?? 0,
      maybeCount: count.get(`${e._id}:maybe`) ?? 0,
    }))
  );
}

// ?filter=upcoming (default: what you may see) | going (you answered) | mine (you host), 20 a page, soonest first.
eventsRouter.get("/", async (req, res) => {
  await processDueEventReminders().catch((err) => console.error("Event reminder check failed:", err.message));
  const filter = ["going", "mine"].includes(req.query.filter) ? req.query.filter : "upcoming";
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(req.query.page, 10) || 1));

  let query = notOver();
  if (filter === "mine") query = { ...query, host: req.user.id };
  if (filter === "going") {
    const answered = await EventRsvp.find({ user: req.user.id }).select("event");
    query = { ...query, _id: { $in: answered.map((r) => r.event) } };
  }
  const found = await Event.find(query).sort({ startsAt: 1, _id: 1 }).limit(SCAN);
  const visible = await canSee(found, req.user.id);
  const slice = visible.slice((page - 1) * PAGE, page * PAGE);
  res.json({ events: await serialize(slice, req.user.id), page, hasMore: visible.length > page * PAGE && page < MAX_PAGE });
});

// Tells the host's accepted friends about it. A failure here must never stop the event from being made.
async function announce(event) {
  try {
    const friends = [...(await friendIdsOf(event.host))];
    if (!friends.length) return;
    await Notification.insertMany(friends.map((recipient) => ({ recipient, type: "event_created", payload: eventPayload(event) })));
  } catch (err) {
    console.error("Couldn't announce an event:", err.message);
  }
}

eventsRouter.post("/", requireVerifiedEmail, async (req, res) => {
  const checked = checkEvent(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if ((await Event.countDocuments({ host: req.user.id, ...notOver() })) >= MAX_UPCOMING_PER_HOST) {
    return res.status(400).json({ error: `You can have up to ${MAX_UPCOMING_PER_HOST} events planned at once` });
  }
  if (!(await createEventLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(createEventLimiter.windowSeconds));
    return res.status(429).json({ error: "You've planned a lot of events — try again later." });
  }
  const event = new Event({ ...checked.value, host: req.user.id });
  event.expireAt = expiryOf(event);
  await event.save();
  await announce(event);
  await notifyMentions({ text: event.description ?? "", actorId: req.user.id, url: `/events/${event._id}`, canSee: async (user) => (await canSee([event], user._id)).length > 0 });
  res.status(201).json({ event: (await serialize([event], req.user.id))[0] });
});

eventsRouter.get("/:id", async (req, res) => {
  const event = await loadVisible(req, res);
  if (!event) return;
  res.json({ event: (await serialize([event], req.user.id))[0] });
});

// The host changes it. People who answered are told when the time, the place or the link changed.
eventsRouter.patch("/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Event not found" });
  const event = await Event.findOne({ _id: req.params.id, host: req.user.id });
  if (!event) return res.status(404).json({ error: "Event not found" });
  if (eventOverAt(event) < Date.now()) return res.status(409).json({ error: "That event is over" });
  const checked = checkEvent(req.body, { current: event });
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!(await allowEdit(req, res))) return;

  const wasDescribed = event.description ?? "";
  const before = { startsAt: event.startsAt.getTime(), endsAt: event.endsAt?.getTime() ?? null, place: event.place, link: event.link, kind: event.kind };
  const changed = Object.entries(checked.value).filter(([key, value]) => {
    const now = value instanceof Date ? value.getTime() : value;
    const was = key in before ? before[key] : event[key];
    return now !== was;
  });
  if (changed.length) {
    event.set(checked.value);
    event.editedAt = new Date();
    event.expireAt = expiryOf(event);
    if (changed.some(([key]) => key === "startsAt")) event.remindedAt = null; // the reminder is for the new time
    await event.save();

    const keys = new Set(changed.map(([key]) => key));
    const what = [];
    if (keys.has("startsAt") || keys.has("endsAt")) what.push("time");
    if (keys.has("place") || keys.has("kind")) what.push("place");
    if (keys.has("link")) what.push("link");
    if (what.length) {
      try {
        const guests = await guestIds(event);
        // one note about a change is enough: an earlier unread one is replaced
        await Notification.deleteMany({ type: "event_updated", "payload.eventId": String(event._id), recipient: { $in: guests }, isRead: false });
        if (guests.length) await Notification.insertMany(guests.map((recipient) => ({ recipient, type: "event_updated", payload: eventPayload(event, { changed: what }) })));
      } catch (err) {
        console.error("Couldn't tell guests about a change:", err.message);
      }
    }
  }
  await notifyMentions({ text: event.description ?? "", before: wasDescribed, actorId: req.user.id, url: `/events/${event._id}`, canSee: async (user) => (await canSee([event], user._id)).length > 0 });
  res.json({ event: (await serialize([event], req.user.id))[0] });
});

// The host cancels it: people who answered are told, and everything it sent is taken back.
eventsRouter.delete("/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Event not found" });
  const event = await Event.findOne({ _id: req.params.id, host: req.user.id });
  if (!event) return res.status(404).json({ error: "Event not found" });
  const guests = await guestIds(event);
  await removeEventNotifications(event._id);
  await EventRsvp.deleteMany({ event: event._id });
  await event.deleteOne();
  if (guests.length && eventOverAt(event) > Date.now()) {
    await Notification.insertMany(guests.map((recipient) => ({ recipient, type: "event_cancelled", payload: { actorId: String(event.host), title: event.title, startsAt: event.startsAt.toISOString() } })));
  }
  res.status(204).end();
});

// Going, maybe, or neither (`none`). The host doesn't answer their own event, and an event that is over can't be answered.
eventsRouter.put("/:id/rsvp", async (req, res) => {
  const status = req.body?.status;
  if (!["going", "maybe", "none"].includes(status)) return res.status(400).json({ error: "status must be going, maybe or none" });
  const event = await loadVisible(req, res);
  if (!event) return;
  if (String(event.host) === req.user.id) return res.status(400).json({ error: "You're hosting this one" });
  if (eventOverAt(event) < Date.now()) return res.status(409).json({ error: "That event is over" });
  if (!(await rsvpLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(rsvpLimiter.windowSeconds));
    return res.status(429).json({ error: "You're answering too fast — try again in a bit." });
  }
  if (status === "none") await EventRsvp.deleteOne({ event: event._id, user: req.user.id });
  else await EventRsvp.findOneAndUpdate({ event: event._id, user: req.user.id }, { event: event._id, user: req.user.id, status }, { upsert: true, setDefaultsOnInsert: true });
  const [goingCount, maybeCount] = await Promise.all([EventRsvp.countDocuments({ event: event._id, status: "going" }), EventRsvp.countDocuments({ event: event._id, status: "maybe" })]);
  res.json({ myStatus: status === "none" ? null : status, goingCount, maybeCount });
});

// Who said going (or maybe), 50 a page, in the order they answered. People the viewer has blocked (or who blocked them) are left out.
eventsRouter.get("/:id/guests", async (req, res) => {
  const event = await loadVisible(req, res);
  if (!event) return;
  const status = req.query.status === "maybe" ? "maybe" : "going";
  const page = Math.min(1000, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const blocked = await blockedUserIds(req.user.id);
  const found = await EventRsvp.find({ event: event._id, status, user: { $nin: [...blocked] } })
    .sort({ _id: 1 })
    .skip((page - 1) * GUESTS_PAGE)
    .limit(GUESTS_PAGE + 1);
  const rsvps = found.slice(0, GUESTS_PAGE);
  const users = await User.find({ _id: { $in: rsvps.map((r) => r.user) }, suspendedAt: null });
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const guests = await Promise.all(rsvps.map((r) => byId.get(String(r.user))).filter(Boolean).map((u) => toPublicUser(u, req.user.id)));
  res.json({ guests, page, hasMore: found.length > GUESTS_PAGE });
});

// ---- add to a calendar (.ics)
const icsText = (value) => String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsStamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
// lines longer than 75 bytes continue on the next line, which starts with a space
function fold(line) {
  const out = [];
  let rest = Buffer.from(line, "utf8");
  while (rest.length > 74) {
    let cut = 74;
    while (cut > 0 && (rest[cut] & 0xc0) === 0x80) cut -= 1; // never inside a multi-byte character
    out.push(rest.subarray(0, cut).toString("utf8"));
    rest = Buffer.concat([Buffer.from(" "), rest.subarray(cut)]);
  }
  out.push(rest.toString("utf8"));
  return out.join("\r\n");
}

eventsRouter.get("/:id/calendar.ics", async (req, res) => {
  const event = await loadVisible(req, res);
  if (!event) return;
  const end = event.endsAt ?? new Date(event.startsAt.getTime() + 60 * 60 * 1000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CreativesSelect//Events//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${event._id}@creativesselect.com`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(event.startsAt)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsText(event.title)}`,
    ...(event.description ? [`DESCRIPTION:${icsText(event.description)}`] : []),
    ...(event.place || event.link ? [`LOCATION:${icsText(event.place || event.link)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="event.ics"');
  res.send(lines.map(fold).join("\r\n") + "\r\n");
});
