import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

describe("changing your password", () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  async function signup() {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({
      email: "sam@example.com",
      username: "sam",
      password: "old-password-1",
      displayName: "Sam",
    });
    return agent;
  }
  const login = (password) =>
    request(app).post("/api/auth/login").send({ email: "sam@example.com", password });

  it("requires being signed in", async () => {
    const res = await request(app).put("/api/auth/password").send({ currentPassword: "a", newPassword: "b-long-enough" });
    expect(res.status).toBe(401);
  });

  it("changes the password: the new one logs in, the old one no longer does", async () => {
    const sam = await signup();
    const res = await sam.put("/api/auth/password").send({ currentPassword: "old-password-1", newPassword: "brand-new-pass-2" });
    expect(res.status).toBe(204);

    expect((await login("brand-new-pass-2")).status).toBe(200);
    expect((await login("old-password-1")).status).toBe(401);
  }, 30_000);

  it("signs out every other session but keeps the one that changed the password", async () => {
    const sam = await signup();
    // A second session (e.g. another device), created before the change.
    const other = request.agent(app);
    await other.post("/api/auth/login").send({ email: "sam@example.com", password: "old-password-1" });
    expect((await other.get("/api/auth/me")).status).toBe(200);

    await new Promise((r) => setTimeout(r, 1100)); // JWT issue times have 1-second resolution
    expect((await sam.put("/api/auth/password").send({ currentPassword: "old-password-1", newPassword: "brand-new-pass-2" })).status).toBe(204);

    expect((await other.get("/api/auth/me")).status).toBe(401);
    expect((await sam.get("/api/auth/me")).status).toBe(200);
  }, 30_000);

  it("refuses a wrong current password without changing anything", async () => {
    const sam = await signup();
    const res = await sam.put("/api/auth/password").send({ currentPassword: "not-it", newPassword: "brand-new-pass-2" });
    expect(res.status).toBe(403);
    expect((await login("old-password-1")).status).toBe(200);
  });

  it("validates the new password and requires it to differ", async () => {
    const sam = await signup();
    expect((await sam.put("/api/auth/password").send({ currentPassword: "old-password-1", newPassword: "short" })).status).toBe(400);
    expect((await sam.put("/api/auth/password").send({ currentPassword: "old-password-1" })).status).toBe(400);
    expect((await sam.put("/api/auth/password").send({ currentPassword: "old-password-1", newPassword: "old-password-1" })).status).toBe(400);
    expect((await login("old-password-1")).status).toBe(200);
  }, 30_000);

  it("throttles repeated wrong current passwords", async () => {
    const sam = await signup();
    for (let i = 0; i < 5; i++) {
      expect((await sam.put("/api/auth/password").send({ currentPassword: "nope-nope", newPassword: "brand-new-pass-2" })).status).toBe(403);
    }
    const blocked = await sam.put("/api/auth/password").send({ currentPassword: "old-password-1", newPassword: "brand-new-pass-2" });
    expect(blocked.status).toBe(429);
    expect((await login("old-password-1")).status).toBe(200);
  }, 60_000);
});
