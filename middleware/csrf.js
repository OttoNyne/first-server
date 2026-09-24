const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function allowedOrigin() {
  return (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/+$/, "");
}

// The auth cookie is SameSite=None in production (frontend and API are on
// different domains), so the browser attaches it to requests made by ANY
// site. CORS alone doesn't stop that for "simple" requests — the request is
// still sent and acted on. Browsers always send an Origin header on
// cross-origin state-changing requests, so reject any whose Origin isn't the
// frontend. Requests with no Origin (curl, server-to-server, same-origin
// navigation) can't be forged from a victim's browser, so they pass.
export function requireTrustedOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get("origin");
  if (!origin || origin === allowedOrigin()) return next();
  res.status(403).json({ error: "Untrusted origin" });
}
