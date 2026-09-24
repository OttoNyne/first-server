// The address to rate-limit by. In production the frontend proxies /api/* to
// this server through Vercel (so the browser only talks to one domain and
// cookies stay first-party — required on iOS/Safari). Behind that proxy the
// connection's own address is Vercel's, shared by every user, so per-IP limits
// would otherwise apply to the whole site at once. Vercel sets
// `x-vercel-forwarded-for` to the real client address (overwriting anything
// the client sent through it); use that when present, else Express's own
// `req.ip` (which trusts Render's proxy hop).
//
// Caveat: someone calling this server directly (not through Vercel) can send
// that header themselves, so per-IP limits are best-effort against a
// deliberate attacker. The strong limits — per email for login, per user for
// everything else — don't depend on the IP.
export function clientIp(req) {
  const forwarded = req.get("x-vercel-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || req.ip;
}
