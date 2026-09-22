import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file shares one MongoDB database (creativeselect_test),
    // and each file's own beforeEach wipes every collection in it. Running
    // files in parallel (Vitest's default) lets one file's clearTestDb()
    // erase another file's in-progress test data — confirmed as the cause
    // of an intermittent failure. Sequential execution costs nothing
    // meaningful at this suite's size and removes the race entirely.
    fileParallelism: false,
    // Each file opens its own fresh connection to the real MongoDB Atlas
    // cluster (SRV lookup + TLS + auth handshake) rather than a local/mocked
    // DB — comfortably under Vitest's default 10s hook timeout on a fast
    // connection, but not always on a slower one. Bumped rather than left to
    // fail intermittently.
    hookTimeout: 20000,
  },
});
