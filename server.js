import { loadEnv, connectDB } from "./config/db.js";
import { ensureUploadDirs } from "./middleware/upload.js";

// Static imports are evaluated before any of this file's own statements run,
// so an `import { app } from "./app.js"` at the top would build app.js's
// middleware (including cors(), which reads process.env.CLIENT_URL once at
// setup time) before loadEnv() below ever populates process.env — silently
// locking CORS to its undefined-fallback origin. A dynamic import, run after
// loadEnv(), guarantees the env is loaded first.
loadEnv();
await connectDB();
ensureUploadDirs();

const { app } = await import("./app.js");

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
