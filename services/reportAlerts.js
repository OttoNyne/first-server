import { Report } from "../models/Report.js";
import { User } from "../models/User.js";
import { adminEmails } from "../utils/admin.js";
import { emailFor } from "../utils/emailText.js";
import { mailAvailable, sendMail } from "../utils/mailer.js";
import { primaryClientUrl } from "../utils/origins.js";

// Telling the moderators that something is waiting. An open report that nobody has been told about is "unalerted"; this sends the people who may
// moderate one email that says how many are waiting and where to look, and marks those reports as told.
//
//   - Only counts and a link, never what was reported, what the reason said or who reported it: a report's words come from anyone, and an
//     email to a moderator must not be a way to put a link or a message in front of one.
//   - At most one email every five minutes however many reports arrive (the ones in between wait for the next one), so a flood of reports
//     is one email, not a hundred.
//   - Reports are claimed with one database update before anything is sent, so two requests (or two servers) can't both send for the same ones.
//   - Only administrators whose address is confirmed on an active account (the same rule as the review queue itself), and only reports from the
//     last day, so switching this on doesn't announce every old report at once.
//   - Called when a report is filed and by a timer, so a report that arrived during the quiet five minutes is told about once it ends.
export const COOLDOWN_MS = 5 * 60 * 1000;
export const WINDOW_MS = 24 * 60 * 60 * 1000;

const running = new Set();

/** Send the alert if there is something new to say and the quiet time has passed. Returns { sent, reports } (the people emailed and the reports told about). */
export async function alertAdminsOfReports({ at } = {}) {
  const none = { sent: 0, reports: 0 };
  if (process.env.REPORT_ALERTS === "off" || !mailAvailable()) return none;
  const now = at ?? new Date();

  const emails = adminEmails();
  if (emails.length === 0) return none;
  const admins = await User.find({ email: { $in: emails }, emailVerified: true, suspendedAt: null }).select("email displayName language");
  if (admins.length === 0) return none; // nobody to tell yet: the reports stay unalerted until somebody can be

  const last = await Report.findOne({ alertedAt: { $ne: null } }).sort({ alertedAt: -1 }).select("alertedAt").lean();
  if (last && now.getTime() - last.alertedAt.getTime() < COOLDOWN_MS) return none;

  const claimed = await Report.updateMany({ status: "open", alertedAt: null, createdAt: { $gte: new Date(now.getTime() - WINDOW_MS) } }, { $set: { alertedAt: now } });
  if (claimed.modifiedCount === 0) return none; // nothing new, or another run claimed them first

  const open = await Report.countDocuments({ status: "open" });
  const base = process.env.CLIENT_URL ? primaryClientUrl() : "http://localhost:5173";
  let sent = 0;
  for (const admin of admins) {
    const mail = emailFor("reportAlert", admin, { name: admin.displayName, count: claimed.modifiedCount, open, link: `${base}/admin/moderation` });
    const result = await sendMail({ to: admin.email, ...mail });
    if (result.sent) sent += 1;
  }
  return { sent, reports: claimed.modifiedCount };
}

/** Start an alert in the background (after a report is filed): never waits, never throws. */
export function queueReportAlert() {
  const work = alertAdminsOfReports()
    .catch((err) => console.error("Couldn't send the report alert:", err.message))
    .finally(() => running.delete(work));
  running.add(work);
}

/** Resolves when every alert started so far has finished (for tests). */
export async function settleReportAlerts() {
  while (running.size) await Promise.allSettled([...running]);
}

/** Looks every minute for reports that waited out the quiet time (not started by tests, which call alertAdminsOfReports directly). */
export function startReportAlertTimer(everyMs = 60_000) {
  const timer = setInterval(() => queueReportAlert(), everyMs);
  timer.unref?.();
  return timer;
}
