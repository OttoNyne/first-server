import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { Session } from "../models/Session.js";
import { AUTH_COOKIE_NAME, setAuthCookie, signAuthToken } from "../middleware/auth.js";
import { deviceLabel } from "../utils/deviceLabel.js";

// The sign-in cookie lasts seven days (see middleware/auth.js), and so does the row that lets it be listed and ended.
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Signing in over and over (or from a script) can't pile up rows: past this many, the least recently used go.
export const MAX_SESSIONS = 20;

/** Records this sign-in, so it shows in the person's list of devices, and gives the browser its cookie. */
export async function startSession(req, res, user) {
  const now = new Date();
  const session = await Session.create({ user: user._id, device: deviceLabel(req.get("user-agent")), createdAt: now, lastSeenAt: now, expireAt: new Date(now.getTime() + SESSION_TTL_MS) });
  setAuthCookie(res, signAuthToken(user, session._id));
  const extra = await Session.find({ user: user._id }).sort({ lastSeenAt: -1 }).skip(MAX_SESSIONS).select("_id");
  if (extra.length) await Session.deleteMany({ _id: { $in: extra.map((s) => s._id) } });
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
