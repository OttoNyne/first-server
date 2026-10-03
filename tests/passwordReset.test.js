import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

// Mail is captured instead of sent. `outbox` holds what would have gone out.
const outbox = [];
let mailShouldFail = false;
let mailIsAvailable = true;
vi.mock("../utils/mailer.js", () => ({
  mailAvailable: () => mailIsAvailable,
  sendMail: vi.fn(async (mail) => {
    if (mailShouldFail) return { sent: false };
    outbox.push(mail);
    return { sent: true };
  }),
}));

const tokenFrom = (mail) => mail.text.match(/#token=([a-f0-9]+)/)[1];

async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({
    email: `${name}@example.com`,
    username: name,
    password: "password123",
    displayName: name,
  });
  return { agent, user: res.body.user };
}

describe("forgotten password", () => {
  let app;
  let PasswordReset;
  let RateLimitHit;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ PasswordReset } = await import("../models/PasswordReset.js"));
    ({ RateLimitHit } = await import("../models/RateLimitHit.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
    outbox.length = 0;
    mailShouldFail = false;
    mailIsAvailable = true;
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const forgot = (email) => request(app).post("/api/auth/forgot-password").send({ email });
  const reset = (token, newPassword) => request(app).post("/api/auth/reset-password").send({ token, newPassword });
  const login = (email, password) => request(app).post("/api/auth/login").send({ email, password });
  // The email is sent after the response, so wait for it to show up.
  const mailArrives = () => vi.waitFor(() => expect(outbox.length).toBeGreaterThan(0), { timeout: 5000 });

  it("emails a reset link to a registered address, with the token in the URL fragment", async () => {
    await signup(app, "alice");
    const res = await forgot("alice@example.com");
    expect(res.status).toBe(200);
    await mailArrives();
    expect(outbox[0].to).toBe("alice@example.com");
    expect(outbox[0].subject).toMatch(/reset/i);
    expect(outbox[0].text).toMatch(/\/reset-password#token=[a-f0-9]{64}/);
    expect(outbox[0].text).not.toMatch(/\?token=/); // never in the query string
  });

  it("answers identically for an address with no account, and sends nothing", async () => {
    await signup(app, "alice");
    const known = await forgot("alice@example.com");
    const unknown = await forgot("nobody@example.com");
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    await mailArrives();
    await new Promise((r) => setTimeout(r, 500));
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe("alice@example.com");
  });

  it("says so honestly when the site has no way to send email, instead of promising a link", async () => {
    mailIsAvailable = false;
    await signup(app, "alice");
    const res = await forgot("alice@example.com");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/isn.t set up/);
    expect((await request(app).get("/api/auth/reset-available")).body).toEqual({ available: false });
    expect(await PasswordReset.countDocuments()).toBe(0);
    mailIsAvailable = true;
    expect((await request(app).get("/api/auth/reset-available")).body).toEqual({ available: true });
  });

  it("rejects something that isn't an email address", async () => {
    expect((await forgot("not-an-email")).status).toBe(400);
    expect((await request(app).post("/api/auth/forgot-password").send({})).status).toBe(400);
    expect((await request(app).post("/api/auth/forgot-password").send({ email: { $ne: "" } })).status).toBe(400);
  });

  it("stores only a hash of the token", async () => {
    await signup(app, "alice");
    await forgot("alice@example.com");
    await mailArrives();
    const token = tokenFrom(outbox[0]);
    const row = await PasswordReset.findOne();
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.expireAt.getTime()).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
    expect(row.expireAt.getTime()).toBeLessThanOrEqual(Date.now() + 61 * 60 * 1000);
  });

  it("resets the password: the new one works, the old one doesn't, and the link can't be reused", async () => {
    await signup(app, "alice");
    await forgot("alice@example.com");
    await mailArrives();
    const token = tokenFrom(outbox[0]);

    expect((await reset(token, "a-brand-new-pass")).status).toBe(204);
    expect((await login("alice@example.com", "a-brand-new-pass")).status).toBe(200);
    expect((await login("alice@example.com", "password123")).status).toBe(401);

    const again = await reset(token, "another-new-pass-1");
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/invalid or has expired/i);
    expect((await login("alice@example.com", "a-brand-new-pass")).status).toBe(200);
    expect(await PasswordReset.countDocuments()).toBe(0);
  });

  it("signs out sessions that existed before the reset, and tells the owner it happened", async () => {
    const alice = await signup(app, "alice");
    expect((await alice.agent.get("/api/auth/me")).status).toBe(200);
    await forgot("alice@example.com");
    await mailArrives();
    // (no pause: a session made in the same second as the reset is signed out too)
    await reset(tokenFrom(outbox[0]), "a-brand-new-pass");

    expect((await alice.agent.get("/api/auth/me")).status).toBe(401);
    await vi.waitFor(() => expect(outbox.some((m) => /password was changed/i.test(m.subject))).toBe(true));
  });

  it("doesn't sign anyone in by itself", async () => {
    await signup(app, "alice");
    await forgot("alice@example.com");
    await mailArrives();
    const res = await reset(tokenFrom(outbox[0]), "a-brand-new-pass");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("only the newest link works when a second one is requested", async () => {
    await signup(app, "alice");
    await forgot("alice@example.com");
    await mailArrives();
    const first = tokenFrom(outbox[0]);
    await forgot("alice@example.com");
    await vi.waitFor(() => expect(outbox.filter((m) => /Reset your/.test(m.subject))).toHaveLength(2));
    const second = tokenFrom(outbox.filter((m) => /Reset your/.test(m.subject))[1]);

    expect((await reset(first, "a-brand-new-pass")).status).toBe(400);
    expect((await reset(second, "a-brand-new-pass")).status).toBe(204);
  });

  it("refuses an expired, unknown or malformed link", async () => {
    await signup(app, "alice");
    await forgot("alice@example.com");
    await mailArrives();
    const token = tokenFrom(outbox[0]);
    await PasswordReset.updateMany({}, { $set: { expireAt: new Date(Date.now() - 1000) } });

    for (const bad of [token, "f".repeat(64), "short", "x".repeat(300)]) {
      const res = await reset(bad, "a-brand-new-pass");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid or has expired/i);
    }
    expect((await request(app).post("/api/auth/reset-password").send({ newPassword: "a-brand-new-pass" })).status).toBe(400);
    expect((await request(app).post("/api/auth/reset-password").send({ token: { $ne: "" }, newPassword: "a-brand-new-pass" })).status).toBe(400);
    expect((await login("alice@example.com", "password123")).status).toBe(200); // untouched
  });

  it("enforces the password rules on the new password and keeps the link usable after a bad one", async () => {
    await signup(app, "alice");
    await forgot("alice@example.com");
    await mailArrives();
    const token = tokenFrom(outbox[0]);
    expect((await reset(token, "short")).status).toBe(400);
    expect((await reset(token, "x".repeat(73))).status).toBe(400);
    expect((await reset(token, "a-brand-new-pass")).status).toBe(204);
  });

  it("limits requests per address (3 an hour), counting unknown addresses too", async () => {
    await signup(app, "alice");
    for (let i = 0; i < 3; i++) expect((await forgot("alice@example.com")).status).toBe(200);
    const limited = await forgot("ALICE@example.com"); // case doesn't dodge it
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();

    for (let i = 0; i < 3; i++) expect((await forgot("ghost@example.com")).status).toBe(200);
    expect((await forgot("ghost@example.com")).status).toBe(429);
  });

  it("limits requests per client address", async () => {
    const now = Date.now();
    await RateLimitHit.insertMany(
      Array.from({ length: 10 }, () => ({ key: "forgot-ip:::ffff:127.0.0.1", at: new Date(now), expireAt: new Date(now + 3600000) }))
    );
    await RateLimitHit.insertMany(
      Array.from({ length: 10 }, () => ({ key: "forgot-ip:::1", at: new Date(now), expireAt: new Date(now + 3600000) }))
    );
    await RateLimitHit.insertMany(
      Array.from({ length: 10 }, () => ({ key: "forgot-ip:127.0.0.1", at: new Date(now), expireAt: new Date(now + 3600000) }))
    );
    expect((await forgot("anyone@example.com")).status).toBe(429);
  });

  it("throttles guessing at tokens", async () => {
    for (let i = 0; i < 10; i++) expect((await reset("f".repeat(64), "a-brand-new-pass")).status).toBe(400);
    expect((await reset("f".repeat(64), "a-brand-new-pass")).status).toBe(429);
  });

  it("still answers normally when the mail provider fails", async () => {
    await signup(app, "alice");
    mailShouldFail = true;
    expect((await forgot("alice@example.com")).status).toBe(200);
  });

  it("removes outstanding reset links when the account is deleted", async () => {
    const alice = await signup(app, "alice");
    await forgot("alice@example.com");
    await mailArrives();
    // (scoped to her: an earlier test's background email job may still be finishing)
    expect(await PasswordReset.countDocuments({ user: alice.user.id })).toBe(1);
    expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
    expect(await PasswordReset.countDocuments({ user: alice.user.id })).toBe(0);
  });
});
