import express from "express";
import mongoose from "mongoose";
import morgan from "morgan";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { requestTimer } from "./middleware/logger.js";
import { errorHandler } from "./middleware/errorHandler.js";

import { authRouter } from "./routes/auth.routes.js";
import { profilesRouter } from "./routes/profiles.routes.js";
import { postsRouter } from "./routes/posts.routes.js";
import { commentsRouter } from "./routes/comments.routes.js";
import { friendsRouter } from "./routes/friends.routes.js";
import { groupsRouter } from "./routes/groups.routes.js";
import { mediaRouter } from "./routes/media.routes.js";
import { mediaCommentsRouter } from "./routes/mediaComments.routes.js";
import { eventsRouter } from "./routes/events.routes.js";
import { aboutRouter } from "./routes/about.routes.js";
import { notificationsRouter } from "./routes/notifications.routes.js";
import { moderationRouter } from "./routes/moderation.routes.js";
import { aiRouter } from "./routes/ai.routes.js";
import { tracksRouter } from "./routes/tracks.routes.js";
import { tasksRouter } from "./routes/tasks.routes.js";
import { messagesRouter } from "./routes/messages.routes.js";
import { liveRouter } from "./routes/live.routes.js";
import { scheduledLivesRouter } from "./routes/scheduledLives.routes.js";
import { blogRouter } from "./routes/blog.routes.js";
import { blogCommentsRouter } from "./routes/blogComments.routes.js";
import { searchRouter } from "./routes/search.routes.js";
import { pushRouter } from "./routes/push.routes.js";
import { bulletinsRouter } from "./routes/bulletins.routes.js";
import { activityRouter } from "./routes/activity.routes.js";
import { profileViewsRouter } from "./routes/profileViews.routes.js";
import { albumsRouter } from "./routes/albums.routes.js";
import { groupBoardRouter } from "./routes/groupBoard.routes.js";
import { invitesRouter } from "./routes/invites.routes.js";
import { onboardingRouter } from "./routes/onboarding.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { securityRouter } from "./routes/security.routes.js";
import { twoFactorRouter } from "./routes/twoFactor.routes.js";
import { emailChangeRouter } from "./routes/emailChange.routes.js";
import { requireTrustedOrigin } from "./middleware/csrf.js";
import { isAllowedOrigin } from "./utils/origins.js";

export const app = express();

// Behind Render's proxy: trust one hop so req.ip is the real client address
// (used for per-IP rate limits) instead of the proxy's.
app.set("trust proxy", 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  cors({
    // checked on every request, against every address listed in CLIENT_URL
    origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)),
    credentials: true,
  })
);
// CSRF defense for the cross-site auth cookie (see middleware/csrf.js).
app.use(requireTrustedOrigin);
app.use(morgan("dev"));
app.use(requestTimer);
app.use(express.json());
app.use(cookieParser());

// readyState: 1 = connected. A cheap in-memory check, no DB round-trip —
// this is what would have caught the stale-hostname outage in the security
// review: the server stayed "up" while every DB-backed route silently
// failed, because this endpoint never looked past its own process state.
app.get("/api/health", (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.status(dbConnected ? 200 : 503).json({ ok: dbConnected, db: dbConnected ? "connected" : "disconnected" });
});

app.get("/api/hello", (req, res) => {
  res.json({ message: "hello" });
});

app.use("/api/auth", authRouter);
app.use("/api/auth", securityRouter);
app.use("/api/auth", twoFactorRouter);
app.use("/api/auth", emailChangeRouter);
app.use("/api/profiles", profilesRouter);
// commentsRouter must be mounted before postsRouter: it defines the more
// specific /posts/:postId/comments routes (deliberately public for GET),
// while postsRouter applies a blanket requireAuth to everything under
// /api/posts — if postsRouter ran first, an anonymous GET here would be
// rejected by that blanket auth before ever reaching this router's own,
// intentionally public, handler.
app.use("/api", commentsRouter);
app.use("/api/posts", postsRouter);
app.use("/api/friends", friendsRouter);
app.use("/api/groups", groupsRouter);
app.use("/api/groups", groupBoardRouter);
app.use("/api/media", mediaRouter);
app.use("/api/media", mediaCommentsRouter);
app.use("/api/events", eventsRouter);
app.use("/api/about", aboutRouter);
// invite previews are public (the person opening the link isn't signed in), so this goes before moderationRouter, which asks for a sign-in on everything under /api
app.use("/api/invites", invitesRouter);
// albums can be looked at without signing in, so they go before moderationRouter, which asks for a sign-in on everything under /api
app.use("/api/albums", albumsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api", moderationRouter);
app.use("/api/ai", aiRouter);
app.use("/api/tracks", tracksRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/scheduled-lives", scheduledLivesRouter);
app.use("/api/blog", blogRouter);
app.use("/api/blog", blogCommentsRouter);
app.use("/api/search", searchRouter);
app.use("/api/push", pushRouter);
app.use("/api/bulletins", bulletinsRouter);
app.use("/api/activity", activityRouter);
app.use("/api/profile-views", profileViewsRouter);
app.use("/api/onboarding", onboardingRouter);
app.use("/api/admin", adminRouter);
app.use("/api/live", liveRouter);

app.use(errorHandler);
