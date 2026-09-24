import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

describe("abuse protection", () => {
  let app;
  let createLimiter;

  beforeAll(async () => {
    await connectTestDb();
    process.env.CLIENT_URL = "https://app.example.com";
    ({ app } = await import("../app.js"));
    ({ createLimiter } = await import("../utils/rateLimit.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const account = { email: "sam@example.com", username: "sam", password: "password123", displayName: "Sam" };

  describe("login throttling", () => {
    it("locks an email out after 10 failed attempts, even with the right password", async () => {
      await request(app).post("/api/auth/register").send(account);
      for (let i = 0; i < 10; i++) {
        const bad = await request(app).post("/api/auth/login").send({ email: account.email, password: "wrong-password" });
        expect(bad.status).toBe(401);
      }
      const locked = await request(app).post("/api/auth/login").send({ email: account.email, password: account.password });
      expect(locked.status).toBe(429);
      expect(locked.headers["retry-after"]).toBeDefined();
    }, 60_000);

    it("doesn't count successful logins against the limit", async () => {
      await request(app).post("/api/auth/register").send(account);
      for (let i = 0; i < 12; i++) {
        const ok = await request(app).post("/api/auth/login").send({ email: account.email, password: account.password });
        expect(ok.status).toBe(200);
      }
    }, 60_000);

    it("tracks emails independently", async () => {
      await request(app).post("/api/auth/register").send(account);
      for (let i = 0; i < 10; i++) {
        await request(app).post("/api/auth/login").send({ email: "victim@example.com", password: "nope-nope" });
      }
      const other = await request(app).post("/api/auth/login").send({ email: account.email, password: account.password });
      expect(other.status).toBe(200);
    }, 60_000);
  });

  it("caps registrations per IP", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/auth/register")
        .send({ ...account, email: `u${i}@example.com`, username: `user${i}` });
      expect(res.status).toBe(201);
    }
    const over = await request(app)
      .post("/api/auth/register")
      .send({ ...account, email: "u11@example.com", username: "user11" });
    expect(over.status).toBe(429);
  }, 60_000);

  describe("cross-site request protection (CSRF)", () => {
    it("rejects state-changing requests from an untrusted origin", async () => {
      const res = await request(app)
        .post("/api/auth/logout")
        .set("Origin", "https://evil.example.net");
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/origin/i);
    });

    it("rejects a 'null' origin (sandboxed iframes, some redirects)", async () => {
      const res = await request(app).post("/api/auth/logout").set("Origin", "null");
      expect(res.status).toBe(403);
    });

    it("allows the real frontend origin", async () => {
      const res = await request(app).post("/api/auth/logout").set("Origin", "https://app.example.com");
      expect(res.status).toBe(204);
    });

    it("allows requests with no Origin (curl, server-to-server) and never blocks reads", async () => {
      expect((await request(app).post("/api/auth/logout")).status).toBe(204);
      const read = await request(app).get("/api/health").set("Origin", "https://evil.example.net");
      expect(read.status).toBe(200);
    });
  });

  describe("shared limiter", () => {
    it("shares state between separate limiter instances (as separate servers would)", async () => {
      const a = createLimiter({ name: "shared-test", limit: 2, windowMs: 60_000 });
      const b = createLimiter({ name: "shared-test", limit: 2, windowMs: 60_000 });
      expect(await a.allow("user-1")).toBe(true);
      expect(await b.allow("user-1")).toBe(true);
      expect(await a.allow("user-1")).toBe(false);
      expect(await b.allow("user-1")).toBe(false);
      expect(await b.allow("user-2")).toBe(true);
    });

    it("forgets hits once the window has passed", async () => {
      const limiter = createLimiter({ name: "window-test", limit: 1, windowMs: 200 });
      expect(await limiter.allow("k")).toBe(true);
      expect(await limiter.allow("k")).toBe(false);
      await new Promise((r) => setTimeout(r, 300));
      expect(await limiter.allow("k")).toBe(true);
    });
  });
});
