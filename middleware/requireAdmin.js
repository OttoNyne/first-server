import { User } from "../models/User.js";
import { requireAuth } from "./auth.js";
import { isAdminUser } from "../utils/admin.js";

// For the moderation routes: signed in AND an administrator. Everyone else gets the same 404 as a path that doesn't exist, so the
// routes don't announce themselves, and the check is made against the database on every request (a person removed from
// ADMIN_EMAILS, or whose address is no longer confirmed, loses access at once).
export function requireAdmin(req, res, next) {
  requireAuth(req, res, async (err) => {
    if (err) return next(err);
    try {
      const user = await User.findById(req.user.id).select("email emailVerified");
      if (!isAdminUser(user)) return res.status(404).json({ error: "Not found" });
      next();
    } catch (e) {
      next(e);
    }
  });
}
