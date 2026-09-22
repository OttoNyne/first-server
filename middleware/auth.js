import jwt from "jsonwebtoken";

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

export function requireAuth(req, res, next) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

export function attachUserIfPresent(req, res, next) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // ignore invalid/expired token — treated as anonymous
    }
  }
  next();
}
