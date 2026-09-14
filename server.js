import { loadEnv, connectDB } from "./config/db.js";
import { ensureUploadDirs } from "./middleware/upload.js";
import { app } from "./app.js";

loadEnv();
await connectDB();
ensureUploadDirs();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
