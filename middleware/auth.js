import jwt from "jsonwebtoken";
import { User } from "../models/User.js";

export const AUTH_COOKIE_NAME = "token";

export function signAuthToken(user) {
  return jwt.sign(
    { id: user._id.toString(), username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

export function setAuthCookie(res, token) {
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    // In dev, frontend/backend are different ports on localhost — same
    // registrable domain, so "lax" already sends the cookie cross-port.
    // In production, they're on genuinely different domains (Render vs
    // Vercel) — a cross-site fetch only carries the cookie if it's
    // SameSite=None, which itself requires Secure (HTTPS, true on both
    // platforms). Without this, login would silently "succeed" but no
    // protected route would ever see the cookie.
    sameSite: isProduction ? "none" : "lax",
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
  // matching a SameSite=None; Secure cookie in production, so it's
  // silently ignored and the session cookie never actually clears.
  // Reproduced live: /logout returned 204, but the original cookie stayed
  // valid and the user stayed logged in.
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: isProduction ? "none" : "lax",
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
  const user = await User.findById(payload.id).select("passwordChangedAt");
  if (!user) return null;
  const changedAtSeconds = user.passwordChangedAt ? Math.floor(user.passwordChangedAt.getTime() / 1000) : 0;
  if (payload.iat < changedAtSeconds) return null;
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
      const clientError = ["JsonWebTokenError", "TokenExpiredError", "NotBeforeError"].includes(err?.name);
      if (!clientError) return next(err);
    }
  }
  next();
}
