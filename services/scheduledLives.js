import { ScheduledLive } from "../models/ScheduledLive.js";
import { Notification } from "../models/Notification.js";
import { blockedUserIds } from "../utils/visibility.js";

// How far ahead of the start time the "starting soon" reminder goes out, and how late one is still worth sending
// (a server that was asleep through the start time shouldn't tell people about a live that began hours ago).
export const REMIND_BEFORE_MS = 10 * 60 * 1000;
export const REMIND_GRACE_MS = 2 * 60 * 60 * 1000;
export const KEEP_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

const payloadOf = (plan, extra = {}) => ({ actorId: String(plan.host), scheduledId: String(plan._id), title: plan.title, startsAt: plan.startsAt.toISOString(), ...extra });

// Sends the "starting soon" reminder for every plan that has come due and not had one yet: to everyone who asked, and to
// the host. Each plan is claimed with one atomic update first, so two requests (or two servers) can't both send it.
// Called on a timer and also whenever someone looks at the schedule or their notifications, so a sleeping server catches up.
let lastCheck = 0;
const CHECK_EVERY_MS = 15_000; // everyone's notification polling calls this; once every 15 seconds is plenty
export async function processDueReminders(at) {
  // an explicit time (tests, or a deliberate catch-up) always runs; the casual calls are spaced out
  if (!at) {
    if (Date.now() - lastCheck < CHECK_EVERY_MS) return 0;
    lastCheck = Date.now();
  }
  const now = at ?? new Date();
  const due = await ScheduledLive.find({ status: "scheduled", remindedAt: null, startsAt: { $lte: new Date(now.getTime() + REMIND_BEFORE_MS) } });
  let sent = 0;
  for (const candidate of due) {
    const plan = await ScheduledLive.findOneAndUpdate({ _id: candidate._id, remindedAt: null, status: "scheduled" }, { $set: { remindedAt: now } });
    if (!plan) continue; // someone else got it
    if (now.getTime() - plan.startsAt.getTime() > REMIND_GRACE_MS) continue; // too late to be useful
    try {
      const blocked = await blockedUserIds(plan.host);
      const people = plan.reminders.map(String).filter((id) => !blocked.has(id));
      const recipients = [...new Set([...people, String(plan.host)])];
      await Notification.insertMany(recipients.map((recipient) => ({ recipient, type: "live_reminder", payload: payloadOf(plan, recipient === String(plan.host) ? { own: true } : {}) })));
      sent += recipients.length;
    } catch (err) {
      console.error("Couldn't send live reminders:", err.message);
    }
  }
  return sent;
}

// A plan is over (cancelled, or the live it was for has started): its announcements and reminders have no more use.
export const removePlanNotifications = (planId) =>
  Notification.deleteMany({ type: { $in: ["live_scheduled", "live_reminder"] }, "payload.scheduledId": String(planId) });

// Runs the reminder check every minute for the life of the server (not started by tests, which call it directly).
export function startReminderTimer(everyMs = 60_000) {
  const timer = setInterval(() => {
    processDueReminders().catch((err) => console.error("Reminder check failed:", err.message));
  }, everyMs);
  timer.unref?.();
  return timer;
}
