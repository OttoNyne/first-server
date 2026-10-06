import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { Session } from "../models/Session.js";

export const AUTH_COOKIE_NAME = "token";

const LAST_SEEN_EVERY_MS = 10 * 60 * 1000;

const passwordVersion = (user) => (user.passwordChangedAt ? user.passwordChangedAt.getTime() : 0);

// sid = the Session row this sign-in belongs to (see models/Session.js); ending that row ends the sign-in.
export function signAuthToken(user, sid) {
  return jwt.sign(
    // pv = the password version (when the password last changed, in ms) this session was issued under.
    { id: user._id.toString(), username: user.username, pv: passwordVersion(user), ...(sid ? { sid: String(sid) } : {}) },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

export function setAuthCookie(res, token) {
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    // Lax everywhere. In dev the frontend and API are different ports on
    // localhost (same site). In production the frontend proxies /api/* to this
    // server (see the frontend's vercel.json), so the browser only ever talks
    // to one domain and the cookie is first-party — which iOS/Safari requires
    // (it blocks cookies from a different site than the page even with
    // SameSite=None) and which lets us use the stricter Lax setting.
    sameSite: "lax",
    secure: isProduction,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearAuthCookie(res) {
  const isProduction = process.env.NODE_ENV === "production";
  // A clearing Set-Cookie must repeat the same sameSite/secure attributes
  // the cookie was originally set with — omitting them (res.clearCookie's
  // default) produces a directive the browser doesn't recognize as
  // matching a Secure cookie in production, so it's silently ignored and
  // the session cookie never actually clears. Reproduced live: /logout
  // returned 204, but the original cookie stayed valid and the user stayed
  // logged in.
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
  });
}

// A signed JWT alone isn't enough: it stays cryptographically valid for 7 days
// even after the account is deleted or its password changed. So each request
// also confirms the user still exists and that the token was issued after the
// last password change. (One indexed lookup by _id; the payload we return is
// still just what's in the token.)
async function resolveSession(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET); // throws if forged/expired
  const user = await User.findById(payload.id).select("passwordChangedAt suspendedAt sessionsRevokedAt");
  if (!user) return null;
  if (user.suspendedAt) {
    const err = new Error("This account has been suspended");
    err.name = "SuspendedError";
    throw err;
  }
  if (typeof payload.pv === "number") {
    // Exact: the session is valid only if the password hasn't changed since it was issued, however
    // close together the two happened (whole-second timestamps can't tell apart events in one second).
    if (payload.pv !== passwordVersion(user)) return null;
  } else {
    // Sessions issued before pv existed: the older whole-second comparison.
    const changedAtSeconds = user.passwordChangedAt ? Math.floor(user.passwordChangedAt.getTime() / 1000) : 0;
    if (payload.iat < changedAtSeconds) return null;
  }
  if (payload.sid) {
    // A sign-in made since devices were listed: it works only while its row exists, so ending it from the list ends it everywhere.
    if (!mongoose.isValidObjectId(payload.sid)) return null;
    const row = await Session.findOne({ _id: payload.sid, user: payload.id }).select("lastSeenAt");
    if (!row) return null;
    // "Last used" is only as exact as the owner needs, so most requests write nothing.
    if (Date.now() - row.lastSeenAt.getTime() > LAST_SEEN_EVERY_MS) await Session.updateOne({ _id: row._id }, { lastSeenAt: new Date() });
  } else if (user.sessionsRevokedAt && payload.iat < Math.floor(user.sessionsRevokedAt.getTime() / 1000)) {
    // A sign-in from before devices were listed: it can't be ended one by one, but "sign out everywhere else" still reaches it.
    return null;
  }
  return payload;
}

export async function requireAuth(req, res, next) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  let session;
  try {
    session = await resolveSession(token);
  } catch (err) {
    // A bad/expired token is the client's problem; anything else (e.g. the
    // database being down) is ours and must not masquerade as a logout.
    if (err?.name === "SuspendedError") {
      return res.status(403).json({ error: "This account has been suspended", code: "account_suspended" });
    }
    if (err?.name === "JsonWebTokenError" || err?.name === "TokenExpiredError" || err?.name === "NotBeforeError") {
      return res.status(401).json({ error: "Invalid or expired session" });
    }
    return next(err);
  }
  if (!session) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
  req.user = session;
  next();
}

export async function attachUserIfPresent(req, res, next) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (token) {
    try {
      const session = await resolveSession(token);
      if (session) req.user = session;
    } catch (err) {
      // An invalid/expired/revoked token is treated as anonymous; a real
      // server error is not swallowed.
      const clientError = ["JsonWebTokenError", "TokenExpiredError", "NotBeforeError", "SuspendedError"].includes(err?.name);
      if (!clientError) return next(err);
    }
  }
  next();
}
