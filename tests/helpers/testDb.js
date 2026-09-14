import mongoose from "mongoose";
import { loadEnv } from "../../config/db.js";

// Tests run against a dedicated database (never the dev/demo one), so they
// can freely create and delete data without touching real accounts.
export async function connectTestDb() {
  loadEnv();
  await mongoose.connect(process.env.MONGODB_URI, { dbName: "creativeselect_test" });
}

export async function clearTestDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export async function disconnectTestDb() {
  await mongoose.disconnect();
}
