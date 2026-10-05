import { User } from "../models/User.js";
import { Friendship } from "../models/Friendship.js";
import { Notification } from "../models/Notification.js";
import { blockedUserIds } from "../utils/visibility.js";

const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** The birthdays that fall on a day (UTC): that month and day, plus 29 February on 28 February when the year has no 29th. */
export function birthdaysOn(date) {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const matches = [{ "birthday.month": month, "birthday.day": day }];
  if (month === 2 && day === 28 && !isLeap(date.getUTCFullYear())) matches.push({ "birthday.month": 2, "birthday.day": 29 });
  return matches;
}

// Tells a person's accepted friends it is their birthday: one note per friend, once a year. Each person is claimed with one atomic
// update first (their last-notified year), so two requests, or two servers, can't both send it, and setting the birthday again
// doesn't send another. Called on a timer and whenever someone looks at their notifications, so a sleeping server catches up.
// The day is the UTC day: close to midnight it may arrive a few hours early or late for someone in another time zone.
let lastCheck = 0;
const CHECK_EVERY_MS = 5 * 60 * 1000; // looks only for today's birthdays, and not more often than this however many people poll
export async function processBirthdays(at) {
  if (!at) {
    if (Date.now() - lastCheck < CHECK_EVERY_MS) return 0;
    lastCheck = Date.now();
  }
  const now = at ?? new Date();
  const year = now.getUTCFullYear();
  const due = await User.find({ $or: birthdaysOn(now), lastBirthdayYear: { $ne: year }, suspendedAt: null }).select("_id");
  let sent = 0;
  for (const candidate of due) {
    const person = await User.findOneAndUpdate({ _id: candidate._id, lastBirthdayYear: { $ne: year } }, { $set: { lastBirthdayYear: year } });
    if (!person) continue; // someone else got it
    try {
      const friendships = await Friendship.find({ status: "accepted", $or: [{ requester: person._id }, { addressee: person._id }] });
      const blocked = await blockedUserIds(person._id);
      const friendIds = friendships.map((f) => String(f.requester) === String(person._id) ? String(f.addressee) : String(f.requester)).filter((id) => !blocked.has(id));
      if (!friendIds.length) continue;
      await Notification.insertMany(friendIds.map((recipient) => ({ recipient, type: "friend_birthday", payload: { actorId: String(person._id) } })));
      sent += friendIds.length;
    } catch (err) {
      console.error("Couldn't send birthday notes:", err.message);
    }
  }
  return sent;
}

// Runs the check every ten minutes for the life of the server (not started by tests, which call it directly).
export function startBirthdayTimer(everyMs = 10 * 60 * 1000) {
  const timer = setInterval(() => {
    processBirthdays().catch((err) => console.error("Birthday check failed:", err.message));
  }, everyMs);
  timer.unref?.();
  return timer;
}
