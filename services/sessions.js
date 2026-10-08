import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createHash, randomBytes } from "node:crypto";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { createLimiter } from "../utils/rateLimit.js";
import { sendMail } from "../utils/mailer.js";
import { emailFor } from "../utils/emailText.js";
import { AUTH_COOKIE_NAME, setAuthCookie, signAuthToken } from "../middleware/auth.js";
import { deviceLabel } from "../utils/deviceLabel.js";

// The sign-in cookie lasts seven days (see middleware/auth.js), and so does the row that lets it be listed and ended.
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Signing in over and over (or from a script) can't pile up rows: past this many, the least recently used go.
export const MAX_SESSIONS = 20;

// A browser that has signed in before carries a long-lived random id (the "device" cookie). It is how the site tells "a browser this
// person has used" from "somewhere new", so it can email them about the second kind.
export const DEVICE_COOKIE = "device";
const DEVICE_ID = /^[a-f0-9]{32}$/;
const DEVICE_COOKIE_MS = 365 * 24 * 60 * 60 * 1000;
// How many browsers are remembered per person: past this the oldest are forgotten (and would be told about again).
export const MAX_KNOWN_DEVICES = 20;
// However many new devices someone signs in from, no one is sent more than this many of these emails an hour.
const alertsPerHour = createLimiter({ name: "new-device-alert", limit: 5, windowMs: 60 * 60 * 1000 });

/**
 * Notes which browser this is and, when it is one this person hasn't signed in from before, emails them (if they haven't turned that off).
 * Only a hash of the id is kept, made with the person's own id, so the same browser used for two accounts can't be linked from the
 * database. A person who has no browsers recorded yet (everyone who signed up before this existed) is simply recorded, not emailed:
 * otherwise the first sign-in after the update would warn every one of them about a browser they have used for months. Never fails.
 */
export async function recognizeDevice(req, res, user, { notify = false } = {}) {
  try {
    let id = req.cookies?.[DEVICE_COOKIE];
    if (typeof id !== "string" || !DEVICE_ID.test(id)) id = randomBytes(16).toString("hex");
    res.cookie(DEVICE_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: DEVICE_COOKIE_MS, path: "/" });
    const hash = createHash("sha256").update(`${user._id}:${id}`).digest("hex");

    const person = await User.findById(user._id).select("knownDevices signInAlerts email displayName language");
    if (!person) return;
    if (person.knownDevices.some((d) => d.hash === hash)) return;
    const added = await User.updateOne(
      { _id: person._id, "knownDevices.hash": { $ne: hash } },
      { $push: { knownDevices: { $each: [{ hash, firstSeen: new Date() }], $slice: -MAX_KNOWN_DEVICES } } }
    );
    if (added.modifiedCount !== 1 || !notify || person.knownDevices.length === 0 || person.signInAlerts === false) return;
    if (!(await alertsPerHour.allow(String(person._id)))) return;
    sendMail({
      to: person.email,
      ...emailFor("newSignIn", person, { name: person.displayName, device: deviceLabel(req.get("user-agent")), when: new Date().toUTCString() }),
    }).catch((err) => console.error("New-device email failed:", err.message));
  } catch (err) {
    console.error("Recognising the device failed:", err.message);
  }
}

/** Records this sign-in, so it shows in the person's list of devices, and gives the browser its cookie. */
export async function startSession(req, res, user, { notify = false } = {}) {
  const now = new Date();
  const session = await Session.create({ user: user._id, device: deviceLabel(req.get("user-agent")), createdAt: now, lastSeenAt: now, expireAt: new Date(now.getTime() + SESSION_TTL_MS) });
  setAuthCookie(res, signAuthToken(user, session._id));
  const extra = await Session.find({ user: user._id }).sort({ lastSeenAt: -1 }).skip(MAX_SESSIONS).select("_id");
  if (extra.length) await Session.deleteMany({ _id: { $in: extra.map((s) => s._id) } });
  await recognizeDevice(req, res, user, { notify });
  return session;
}

/** Ends the sign-in this request's cookie belongs to, if it has one. Never fails: signing out always works. */
export async function endSessionOf(req) {
  try {
    const payload = jwt.verify(req.cookies?.[AUTH_COOKIE_NAME] ?? "", process.env.JWT_SECRET);
    if (payload.sid && mongoose.isValidObjectId(payload.sid) && mongoose.isValidObjectId(payload.id)) await Session.deleteOne({ _id: payload.sid, user: payload.id });
  } catch {
    // no cookie, or one that no longer works: nothing to end
  }
}

/** Ends every sign-in a person has (their password changed, or the account is going). */
export const endAllSessions = (userId) => Session.deleteMany({ user: userId });
