import { User } from "../models/User.js";

// Optionally keeps the most outward-facing actions (starting a live, posting a public request) for people who
// have confirmed their email. Off unless REQUIRE_VERIFIED_EMAIL=true, so a new visitor with an address they can't
// read is never locked out of the rest of the site.
export const verifiedEmailRequired = () => process.env.REQUIRE_VERIFIED_EMAIL === "true";

export async function userHasVerifiedEmail(userId) {
  const user = await User.findById(userId).select("emailVerified");
  return Boolean(user?.emailVerified);
}

export function requireVerifiedEmail(req, res, next) {
  if (!verifiedEmailRequired()) return next();
  userHasVerifiedEmail(req.user.id)
    .then((ok) => (ok ? next() : res.status(403).json({ error: "Confirm your email address first — check your inbox for the link.", code: "email_not_verified" })))
    .catch(next);
}
