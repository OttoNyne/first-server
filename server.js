import { loadEnv, connectDB } from "./config/db.js";

// Static imports are evaluated before any of this file's own statements run,
// so an `import { app } from "./app.js"` at the top would build app.js's
// middleware (including cors(), which reads process.env.CLIENT_URL once at
// setup time) before loadEnv() below ever populates process.env — silently
// locking CORS to its undefined-fallback origin. A dynamic import, run after
// loadEnv(), guarantees the env is loaded first. The same applies to
// middleware/upload.js, which configures the Cloudinary SDK from env vars
// at module load time.
loadEnv();
await connectDB();

const { app } = await import("./app.js");

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
