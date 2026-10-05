import { Event } from "../models/Event.js";
import { EventRsvp } from "../models/EventRsvp.js";
import { Notification } from "../models/Notification.js";
import { blockedUserIds } from "../utils/visibility.js";

// How far ahead of the start the "starting soon" reminder goes out, how late one is still worth sending, how long an event stays
// listed after it began (when it has no end time), and how long it is kept after it is over.
export const EVENT_REMIND_BEFORE_MS = 60 * 60 * 1000;
export const EVENT_REMIND_GRACE_MS = 2 * 60 * 60 * 1000;
export const SHOW_AFTER_START_MS = 6 * 60 * 60 * 1000;
export const KEEP_EVENT_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

/** When an event stops being listed and can no longer be answered: its end, or a few hours after it began. */
export const eventOverAt = (event) => (event.endsAt ? event.endsAt.getTime() : event.startsAt.getTime() + SHOW_AFTER_START_MS);

/** When the database may forget an event. */
export const expiryOf = (event) => new Date(eventOverAt(event) + KEEP_EVENT_AFTER_MS);

const EVENT_NOTIFICATION_TYPES = ["event_created", "event_updated", "event_reminder"];

/** Everything an event said to people (announcement, changes, reminders), once it is cancelled. */
export const removeEventNotifications = (eventId) => Notification.deleteMany({ type: { $in: EVENT_NOTIFICATION_TYPES }, "payload.eventId": String(eventId) });

const payloadOf = (event, extra = {}) => ({ actorId: String(event.host), eventId: String(event._id), title: event.title, startsAt: event.startsAt.toISOString(), ...extra });

/** The people who said they are going or might go, minus anyone the host and they have blocked either way. */
export async function guestIds(event) {
  const blocked = await blockedUserIds(event.host);
  const rsvps = await EventRsvp.find({ event: event._id }).select("user");
  return rsvps.map((r) => String(r.user)).filter((id) => !blocked.has(id));
}

// Sends the "starting soon" reminder for every event that has come due and not had one yet: to everyone who answered, and to the
// host. Each event is claimed with one atomic update first, so two requests (or two servers) can't both send it. Called on a timer
// and whenever someone looks at their notifications or the events, so a sleeping server catches up.
let lastCheck = 0;
const CHECK_EVERY_MS = 15_000;
export async function processDueEventReminders(at) {
  if (!at) {
    if (Date.now() - lastCheck < CHECK_EVERY_MS) return 0;
    lastCheck = Date.now();
  }
  const now = at ?? new Date();
  const due = await Event.find({ remindedAt: null, startsAt: { $lte: new Date(now.getTime() + EVENT_REMIND_BEFORE_MS) } });
  let sent = 0;
  for (const candidate of due) {
    const event = await Event.findOneAndUpdate({ _id: candidate._id, remindedAt: null }, { $set: { remindedAt: now } });
    if (!event) continue; // someone else got it
    if (now.getTime() - event.startsAt.getTime() > EVENT_REMIND_GRACE_MS) continue; // too late to be useful
    try {
      const guests = await guestIds(event);
      const recipients = [...new Set([...guests, String(event.host)])];
      await Notification.insertMany(recipients.map((recipient) => ({ recipient, type: "event_reminder", payload: payloadOf(event, recipient === String(event.host) ? { own: true } : {}) })));
      sent += recipients.length;
    } catch (err) {
      console.error("Couldn't send event reminders:", err.message);
    }
  }
  return sent;
}

// Runs the reminder check every minute for the life of the server (not started by tests, which call it directly).
export function startEventReminderTimer(everyMs = 60_000) {
  const timer = setInterval(() => {
    processDueEventReminders().catch((err) => console.error("Event reminder check failed:", err.message));
  }, everyMs);
  timer.unref?.();
  return timer;
}

export { payloadOf as eventPayload };
