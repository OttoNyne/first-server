import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

const outbox = [];
let mailIsAvailable = true;
let mailShouldFail = false;
vi.mock("../utils/mailer.js", () => ({
  mailAvailable: () => mailIsAvailable,
  sendMail: vi.fn(async (mail) => {
    if (mailShouldFail) return { sent: false };
    outbox.push(mail);
    return { sent: true };
  }),
}));

const isVerification = (m) => /Confirm your/.test(m.subject);
const tokenFrom = (mail) => mail.text.match(/#token=([a-f0-9]+)/)[1];

async function signup(app, name, email = `${name}@example.com`) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ email, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user, status: res.status };
}

describe("email verification", () => {
  let app;
  let EmailVerification;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ EmailVerification } = await import("../models/EmailVerification.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
    outbox.length = 0;
    mailIsAvailable = true;
    mailShouldFail = false;
  });
  afterEach(() => {
    delete process.env.REQUIRE_VERIFIED_EMAIL;
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  // The email goes out after sign-up has replied, so wait for it.
  const mailArrives = (count = 1) => vi.waitFor(() => expect(outbox.filter(isVerification).length).toBeGreaterThanOrEqual(count), { timeout: 5000 });
  const verify = (token) => request(app).post("/api/auth/verify-email").send({ token });
  const me = async (agent) => (await agent.get("/api/auth/me")).body.user;

  describe("at sign-up", () => {
    it("emails a confirmation link to the new address, with the token in the URL fragment, and starts unverified", async () => {
      const alice = await signup(app, "alice");
      expect(alice.status).toBe(201);
      expect(alice.user.emailVerified).toBe(false);
      await mailArrives();
      const mail = outbox.find(isVerification);
      expect(mail.to).toBe("alice@example.com");
      expect(mail.text).toMatch(/\/verify-email#token=[a-f0-9]{64}/);
      expect(mail.text).not.toMatch(/\?token=/);
    });

    it("stores only a hash of the token, valid for about a day", async () => {
      await signup(app, "alice");
      await mailArrives();
      const token = tokenFrom(outbox.find(isVerification));
      const row = await EmailVerification.findOne();
      expect(row.tokenHash).not.toContain(token);
      expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.expireAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
      expect(row.expireAt.getTime()).toBeLessThanOrEqual(Date.now() + 25 * 3600_000);
    });

    it("still signs people up when the site can't send email, or sending fails", async () => {
      mailIsAvailable = false;
      expect((await signup(app, "alice")).status).toBe(201);
      mailIsAvailable = true;
      mailShouldFail = true;
      expect((await signup(app, "bob")).status).toBe(201);
    });
  });

  describe("confirming the address", () => {
    it("marks the account verified, and the link works only once", async () => {
      const alice = await signup(app, "alice");
      await mailArrives();
      const token = tokenFrom(outbox.find(isVerification));
      expect((await me(alice.agent)).emailVerified).toBe(false);

      expect((await verify(token)).status).toBe(204);
      expect((await me(alice.agent)).emailVerified).toBe(true);

      const again = await verify(token);
      expect(again.status).toBe(400);
      expect(again.body.error).toMatch(/invalid or has expired/i);
      // (scoped to her: another test's background email may still be finishing)
      expect(await EmailVerification.countDocuments({ user: alice.user.id })).toBe(0);
    });

    it("needs no sign-in: the link works in a browser where nobody is logged in", async () => {
      const alice = await signup(app, "alice");
      await mailArrives();
      expect((await verify(tokenFrom(outbox.find(isVerification)))).status).toBe(204); // plain request, no cookie
      expect((await me(alice.agent)).emailVerified).toBe(true);
    });

    it("verifies only the account the link was sent to", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await mailArrives(2);
      const forAlice = outbox.filter(isVerification).find((m) => m.to === "alice@example.com");
      await verify(tokenFrom(forAlice));
      expect((await me(alice.agent)).emailVerified).toBe(true);
      expect((await me(bob.agent)).emailVerified).toBe(false);
    });

    it("refuses expired, unknown and malformed links", async () => {
      await signup(app, "alice");
      await mailArrives();
      const token = tokenFrom(outbox.find(isVerification));
      await EmailVerification.updateMany({}, { $set: { expireAt: new Date(Date.now() - 1000) } });
      for (const bad of [token, "f".repeat(64), "short", "x".repeat(300), undefined, 12345, { $ne: "" }]) {
        const res = await request(app).post("/api/auth/verify-email").send({ token: bad });
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(res.body.error).toMatch(/invalid or has expired/i);
      }
    });

    it("throttles guessing at tokens", async () => {
      for (let i = 0; i < 20; i++) expect((await verify("f".repeat(64))).status).toBe(400);
      const limited = await verify("f".repeat(64));
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeTruthy();
    });

    it("keeps the verified status private to the account owner", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await mailArrives(2);
      expect((await me(alice.agent)).emailVerified).toBe(false); // she sees her own
      const theirView = (await bob.agent.get("/api/profiles/alice")).body.user;
      expect(theirView).not.toHaveProperty("emailVerified");
      expect(theirView).not.toHaveProperty("email");
      const search = (await bob.agent.get("/api/profiles?search=alice")).body.users;
      expect(JSON.stringify(search)).not.toMatch(/emailVerified|alice@example.com/);
    });
  });

  describe("asking for another link", () => {
    it("requires being signed in", async () => {
      expect((await request(app).post("/api/auth/resend-verification")).status).toBe(401);
    });

    it("sends a fresh link and kills the old one", async () => {
      const alice = await signup(app, "alice");
      await mailArrives();
      const first = tokenFrom(outbox.find(isVerification));
      expect((await alice.agent.post("/api/auth/resend-verification")).status).toBe(204);
      await mailArrives(2);
      const second = tokenFrom(outbox.filter(isVerification)[1]);
      expect(second).not.toBe(first);
      expect((await verify(first)).status).toBe(400);
      expect((await verify(second)).status).toBe(204);
    });

    it("tells someone who is already confirmed", async () => {
      const alice = await signup(app, "alice");
      await mailArrives();
      await verify(tokenFrom(outbox.find(isVerification)));
      const res = await alice.agent.post("/api/auth/resend-verification");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already confirmed/);
    });

    it("allows 3 an hour and then asks them to wait", async () => {
      const alice = await signup(app, "alice");
      for (let i = 0; i < 3; i++) expect((await alice.agent.post("/api/auth/resend-verification")).status).toBe(204);
      const limited = await alice.agent.post("/api/auth/resend-verification");
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeTruthy();
    });

    it("says so when the site can't send email, or sending fails", async () => {
      const alice = await signup(app, "alice");
      mailIsAvailable = false;
      expect((await alice.agent.post("/api/auth/resend-verification")).status).toBe(503);
      mailIsAvailable = true;
      mailShouldFail = true;
      const res = await alice.agent.post("/api/auth/resend-verification");
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/Couldn't send the email/);
    });
  });

  it("counts a completed password reset as proof of the address", async () => {
    const alice = await signup(app, "alice");
    await request(app).post("/api/auth/forgot-password").send({ email: "alice@example.com" });
    await vi.waitFor(() => expect(outbox.some((m) => /Reset your/.test(m.subject))).toBe(true), { timeout: 5000 });
    const resetToken = tokenFrom(outbox.find((m) => /Reset your/.test(m.subject)));
    expect((await me(alice.agent)).emailVerified).toBe(false);
    expect((await request(app).post("/api/auth/reset-password").send({ token: resetToken, newPassword: "a-brand-new-pass" })).status).toBe(204);
    const fresh = request.agent(app);
    const login = await fresh.post("/api/auth/login").send({ email: "alice@example.com", password: "a-brand-new-pass" });
    expect(login.body.user.emailVerified).toBe(true);
  });

  it("removes outstanding links when the account is deleted", async () => {
    const alice = await signup(app, "alice");
    await mailArrives();
    expect(await EmailVerification.countDocuments({ user: alice.user.id })).toBe(1);
    expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
    expect(await EmailVerification.countDocuments({ user: alice.user.id })).toBe(0);
  });

  describe("requiring a confirmed email (REQUIRE_VERIFIED_EMAIL=true)", () => {
    const publicRequest = { title: "Need a logo", isPublic: true };

    it("is off by default: unconfirmed accounts can go live and post public requests", async () => {
      const alice = await signup(app, "alice");
      expect((await alice.agent.post("/api/live").send({ title: "Hello" })).status).toBe(201);
      expect((await alice.agent.post("/api/tasks").send(publicRequest)).status).toBe(201);
    });

    it("when on, keeps going live and public requests for confirmed accounts, with a clear reason", async () => {
      process.env.REQUIRE_VERIFIED_EMAIL = "true";
      const alice = await signup(app, "alice");
      const live = await alice.agent.post("/api/live").send({ title: "Hello" });
      expect(live.status).toBe(403);
      expect(live.body).toMatchObject({ code: "email_not_verified" });
      expect(live.body.error).toMatch(/Confirm your email/);
      const board = await alice.agent.post("/api/tasks").send(publicRequest);
      expect(board.status).toBe(403);
      expect(board.body.code).toBe("email_not_verified");
    });

    it("when on, still lets unconfirmed accounts do everything else", async () => {
      process.env.REQUIRE_VERIFIED_EMAIL = "true";
      const alice = await signup(app, "alice");
      expect((await alice.agent.post("/api/tasks").send({ title: "Private note" })).status).toBe(201); // not public
      expect((await alice.agent.post("/api/posts").send({ content: "hi" })).status).toBe(201);
      expect((await alice.agent.post("/api/groups").send({ name: "Painters" })).status).toBe(201);
    });

    it("when on, opens up as soon as the address is confirmed", async () => {
      process.env.REQUIRE_VERIFIED_EMAIL = "true";
      const alice = await signup(app, "alice");
      await mailArrives();
      await verify(tokenFrom(outbox.find(isVerification)));
      expect((await alice.agent.post("/api/live").send({ title: "Hello" })).status).toBe(201);
      expect((await alice.agent.post("/api/tasks").send(publicRequest)).status).toBe(201);
    });
  });
});
