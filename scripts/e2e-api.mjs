// "npm run e2e-api": the API for the browser tests (frontend repo, `npx playwright test`), on port 5000, with a MongoDB of its own on this
// computer, no AI keys (the built-in mock is used) and the emails written to a folder instead of sent. It is the same setup CI uses, so a
// local run behaves like CI instead of fighting a slow cloud database. Stop it with Ctrl+C.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";

const mongo = await MongoMemoryServer.create({ binary: { version: process.env.LOCAL_MONGO_VERSION || "7.0.14" }, instance: { dbName: "creativeselect_e2e" } });
const mailDir = mkdtempSync(join(tmpdir(), "creativeselect-mail-"));
console.log(`Browser-test API: http://localhost:5000  (emails are written to ${mailDir})`);
console.log(`Run the browser tests with:  MAIL_OUTBOX_DIR="${mailDir}" npx playwright test   (from the frontend folder)`);

const api = spawn(process.execPath, ["server.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    MONGODB_URI: mongo.getUri("creativeselect_e2e"),
    JWT_SECRET: "e2e-only-secret",
    CLIENT_URL: "http://localhost:4173",
    PORT: "5000",
    NODE_ENV: "test",
    BCRYPT_COST: "4",
    CLOUDFLARE_ACCOUNT_ID: "",
    CLOUDFLARE_API_TOKEN: "",
    MAIL_OUTBOX_DIR: mailDir,
    // who counts as a moderator in the browser tests (one address per browser project)
    ADMIN_EMAILS: "mod-chromium@example.com,mod-webkit@example.com,mod-iphone@example.com",
  },
});
const stop = async () => {
  api.kill();
  await mongo.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
api.on("exit", stop);
