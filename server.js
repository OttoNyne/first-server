import express from "express";
import morgan from "morgan";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { loadEnv, connectDB } from "./config/db.js";
import { requestTimer } from "./middleware/logger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { ensureUploadDirs, UPLOADS_ROOT } from "./middleware/upload.js";

import { authRouter } from "./routes/auth.routes.js";
import { profilesRouter } from "./routes/profiles.routes.js";
import { postsRouter } from "./routes/posts.routes.js";
import { commentsRouter } from "./routes/comments.routes.js";
import { friendsRouter } from "./routes/friends.routes.js";
import { groupsRouter } from "./routes/groups.routes.js";
import { mediaRouter } from "./routes/media.routes.js";
import { notificationsRouter } from "./routes/notifications.routes.js";
import { moderationRouter } from "./routes/moderation.routes.js";
import { aiRouter } from "./routes/ai.routes.js";
import { tracksRouter } from "./routes/tracks.routes.js";
import { tasksRouter } from "./routes/tasks.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnv();
await connectDB();
ensureUploadDirs();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(morgan("dev"));
app.use(requestTimer);
app.use(express.json());
app.use(cookieParser());
app.use("/uploads", express.static(UPLOADS_ROOT));

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/hello", (req, res) => {
  res.json({ message: "hello" });
});

app.use("/api/auth", authRouter);
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
app.use("/api/media", mediaRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api", moderationRouter);
app.use("/api/ai", aiRouter);
app.use("/api/tracks", tracksRouter);
app.use("/api/tasks", tasksRouter);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
