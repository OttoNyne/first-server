import { Router } from "express";
import { AUTH_COOKIE_NAME, requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { openStream } from "../services/liveUpdates.js";

// The live-updates stream (see services/liveUpdates.js): GET /api/updates/stream, for signed-in people only.
export const updatesRouter = Router();

// Opening one is cheap, but a page stuck in a reconnect loop shouldn't be able to hammer the server.
const connects = createLimiter({ name: "updates-stream", limit: 90, windowMs: 15 * 60 * 1000 });

updatesRouter.get("/stream", requireAuth, async (req, res) => {
  try {
    if (!(await connects.allow(req.user.id))) {
      res.set("Retry-After", String(connects.windowSeconds));
      return res.status(429).json({ error: "Too many connections — the page will keep checking on its own." });
    }
    openStream(req, res, { userId: req.user.id, token: req.cookies?.[AUTH_COOKIE_NAME] });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});
