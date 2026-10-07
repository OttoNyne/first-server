import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { codeForStep, stepAt } from "../utils/totp.js";
import { maskEmail } from "../utils/maskEmail.js";

// Mail is captured instead of sent.
const outbox = [];
let mailAvailable = true;
vi.mock("../utils/mailer.js", () => ({
  mailAvailable: () => mailAvailable,
  sendMail: vi.fn(async (mail) => {
    outbox.push(mail);
    return { sent: true };
  }),
}));

describe("maskEmail", () => {
  it("keeps just enough to be recognised", () => {
    expect(maskEmail("zoe@example.com")).toBe("z**@e******.com");
    expect(maskEmail("A@b.io")).toBe("a*@b*.io");
    expect(maskEmail("long.name+tag@mail.example.co.uk")).toBe("l************@m**************.uk");
    expect(maskEmail("ZOE@EXAMPLE.COM")).toBe("z**@e******.com");
  });

  it("copes with odd input without ever returning the address", () => {
    for (const odd of ["", "nobody", "@", "a@", "@b.com", "x@y"]) {
      const masked = maskEmail(odd);
      expect(typeof masked).toBe("string");
      if (odd.length > 3) expect(masked).not.toBe(odd);
    }
  });
});

describe("changing the email address", () => {
  let app;
  let M;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      EmailChange: (await import("../models/EmailChange.js")).EmailChange,
      EmailVerification: (await import("../models/EmailVerification.js")).EmailVerification,
      PasswordReset: (await import("../models/PasswordReset.js")).PasswordReset,
      Session: (await import("../models/Session.js")).Session,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    outbox.length = 0;
    mailAvailable = true;
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const PASSWORD = "password-123";
  async function signup(name) {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: PASSWORD, displayName: name });
    expect(res.status).toBe(201);
    return { agent, user: res.body.user };
  }
  const ask = (me, newEmail, extra = {}) => me.agent.post("/api/auth/email/change").send({ newEmail, password: PASSWORD, ...extra });
  const confirm = (token) => request(app).post("/api/auth/email/confirm").send({ token });
  const revert = (token) => request(app).post("/api/auth/email/revert").send({ token });
  const mailTo = (address, subject) => outbox.filter((m) => m.to === address && subject.test(m.subject));
  const tokenIn = (mail) => mail.text.match(/#token=([a-f0-9]+)/)[1];
  const login = (email, password = PASSWORD) => request(app).post("/api/auth/login").send({ email, password });
  const sha = (t) => createHash("sha256").update(t).digest("hex");

  /** Asks for the change and gets the link out of the mail to the new address. */
  async function requested(me, newEmail = "new@example.com") {
    expect((await ask(me, newEmail)).status).toBe(204);
    await vi.waitFor(() => expect(mailTo(newEmail, /Confirm your new/)).toHaveLength(1));
    return tokenIn(mailTo(newEmail, /Confirm your new/)[0]);
  }
  /** The whole change, and the undo link out of the mail to the old address. */
  async function changed(me, newEmail = "new@example.com") {
    const token = await requested(me, newEmail);
    expect((await confirm(token)).status).toBe(204);
    await vi.waitFor(() => expect(mailTo(me.oldEmail ?? "zoe@example.com", /was changed/)).toHaveLength(1));
    return tokenIn(mailTo("zoe@example.com", /was changed/)[0]);
  }

  describe("asking", () => {
    it("needs a sign-in, a valid new address and the password", async () => {
      expect((await request(app).post("/api/auth/email/change").send({ newEmail: "a@b.com", password: PASSWORD })).status).toBe(401);
      const zoe = await signup("zoe");
      for (const bad of [{}, { newEmail: "nope" }, { newEmail: "" }, { newEmail: "a@b.com" }, { newEmail: { $ne: "" }, password: PASSWORD }, { newEmail: "a@b.com", password: 5 }, { newEmail: `${"a".repeat(250)}@b.com`, password: PASSWORD }]) {
        expect((await zoe.agent.post("/api/auth/email/change").send(bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
      }
      expect(await M.EmailChange.countDocuments()).toBe(0);
    });

    it("refuses a wrong password, counts it, and stops after five", async () => {
      const zoe = await signup("zoe");
      for (let i = 0; i < 5; i++) {
        const res = await zoe.agent.post("/api/auth/email/change").send({ newEmail: "new@example.com", password: "wrong-wrong" });
        expect(res.status).toBe(403);
      }
      const blocked = await ask(zoe, "new@example.com");
      expect(blocked.status).toBe(429);
      expect(blocked.headers["retry-after"]).toBeTruthy();
      expect(outbox.filter((m) => /Confirm your new/.test(m.subject))).toHaveLength(0);
    });

    it("refuses the address it already has, and one another account uses", async () => {
      const zoe = await signup("zoe");
      await signup("sam");
      expect((await ask(zoe, "zoe@example.com")).status).toBe(400);
      expect((await ask(zoe, "  ZOE@Example.com ")).status).toBe(400);
      const taken = await ask(zoe, "sam@example.com");
      expect(taken.status).toBe(409);
      expect(taken.body.error).toMatch(/already used/);
      expect(await M.EmailChange.countDocuments()).toBe(0);
    });

    it("says so when this site can't send email, rather than pretending", async () => {
      const zoe = await signup("zoe");
      mailAvailable = false;
      expect((await ask(zoe, "new@example.com")).status).toBe(503);
      expect(await M.EmailChange.countDocuments()).toBe(0);
    });

    it("sends a link to the new address and a notice to the old one, and changes nothing yet", async () => {
      const zoe = await signup("zoe");
      expect((await ask(zoe, "  New@Example.COM ")).status).toBe(204);
      await vi.waitFor(() => expect(outbox.filter((m) => /Confirm your new|change of email/.test(m.subject))).toHaveLength(2));

      const toNew = mailTo("new@example.com", /Confirm your new/)[0];
      expect(toNew.text).toMatch(/\/confirm-email-change#token=[a-f0-9]{64}/);
      expect(toNew.text).toContain('"zoe"');
      const toOld = mailTo("zoe@example.com", /change of email/)[0];
      expect(toOld.text).toContain("n**@e******.com"); // masked
      expect(toOld.text).not.toContain("new@example.com");
      expect(toOld.text).not.toMatch(/token=/); // the old address gets no link that does anything
      expect(toOld.text).toMatch(/change your password right away/);

      expect((await M.User.findOne({ username: "zoe" })).email).toBe("zoe@example.com");
      expect((await login("zoe@example.com")).status).toBe(200);
      expect((await login("new@example.com")).status).toBe(401);
    });

    it("stores only a hash of the link, and expires it in an hour", async () => {
      const zoe = await signup("zoe");
      const token = await requested(zoe);
      const row = await M.EmailChange.findOne().lean();
      expect(row).toMatchObject({ kind: "pending", oldEmail: "zoe@example.com", newEmail: "new@example.com", tokenHash: sha(token) });
      expect(JSON.stringify(row)).not.toContain(token);
      const minutes = (row.expireAt.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(55);
      expect(minutes).toBeLessThanOrEqual(60);
      expect((await M.EmailChange.collection.indexes()).find((i) => i.key.expireAt === 1)?.expireAfterSeconds).toBe(0);
    });

    it("a second request replaces the first, whose link stops working", async () => {
      const zoe = await signup("zoe");
      const first = await requested(zoe, "first@example.com");
      const second = await requested(zoe, "second@example.com");
      expect(await M.EmailChange.countDocuments({ user: zoe.user.id })).toBe(1);
      expect((await confirm(first)).status).toBe(400);
      expect((await confirm(second)).status).toBe(204);
      expect((await M.User.findOne({ username: "zoe" })).email).toBe("second@example.com");
    });

    it("allows three requests an hour, and a wrong password doesn't use one up", async () => {
      const zoe = await signup("zoe");
      await zoe.agent.post("/api/auth/email/change").send({ newEmail: "x@example.com", password: "wrong-wrong" });
      for (let i = 0; i < 3; i++) expect((await ask(zoe, `try${i}@example.com`)).status).toBe(204);
      const fourth = await ask(zoe, "try4@example.com");
      expect(fourth.status).toBe(429);
      expect(fourth.headers["retry-after"]).toBeTruthy();
    });

    it("with two-step sign-in on, also needs a code (an app code or a recovery code), and counts wrong ones", async () => {
      const zoe = await signup("zoe");
      const setup = await zoe.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD });
      const enable = await zoe.agent.post("/api/auth/2fa/enable").send({ code: codeForStep(setup.body.secret, stepAt()) });
      const recovery = enable.body.recoveryCodes;

      const without = await ask(zoe, "new@example.com");
      expect(without.status).toBe(401);
      expect(without.body.code).toBe("second_step_needed");
      expect((await ask(zoe, "new@example.com", { code: "000000" === codeForStep(setup.body.secret, stepAt()) ? "111111" : "000000" })).status).toBe(401);
      expect(await M.EmailChange.countDocuments()).toBe(0);

      expect((await ask(zoe, "new@example.com", { code: recovery[0] })).status).toBe(204);
      expect(await M.EmailChange.countDocuments()).toBe(1);
      // that recovery code is used up
      expect((await ask(zoe, "other@example.com", { code: recovery[0] })).status).toBe(401);

      await M.RateLimitHit.deleteMany({});
      await M.User.updateOne({ username: "zoe" }, { "twoFactor.lastStep": 0 });
      expect((await ask(zoe, "other@example.com", { code: codeForStep(setup.body.secret, stepAt()) })).status).toBe(204);
    });

    it("with two-step sign-in on, stops guessing codes after five", async () => {
      const zoe = await signup("zoe");
      const setup = await zoe.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD });
      await zoe.agent.post("/api/auth/2fa/enable").send({ code: codeForStep(setup.body.secret, stepAt()) });
      await M.User.updateOne({ username: "zoe" }, { "twoFactor.lastStep": 0 });
      const good = codeForStep(setup.body.secret, stepAt());
      const wrong = good === "123456" ? "654321" : "123456";
      for (let i = 0; i < 5; i++) expect((await ask(zoe, "new@example.com", { code: wrong })).status).toBe(401);
      expect((await ask(zoe, "new@example.com", { code: good })).status).toBe(429);
    });
  });

  describe("confirming from the new address", () => {
    it("changes the email, counts it as confirmed, signs no one in, and leaves the person's own sign-ins alone", async () => {
      const zoe = await signup("zoe");
      const token = await requested(zoe);
      const res = await confirm(token);
      expect(res.status).toBe(204);
      expect(res.headers["set-cookie"]).toBeUndefined();

      const user = await M.User.findOne({ username: "zoe" });
      expect(user.email).toBe("new@example.com");
      expect(user.emailVerified).toBe(true);
      expect((await login("new@example.com")).status).toBe(200);
      expect((await login("zoe@example.com")).status).toBe(401);
      expect((await zoe.agent.get("/api/auth/me")).body.user.email).toBe("new@example.com");
      expect((await zoe.agent.get("/api/auth/me")).status).toBe(200);
    });

    it("forgets the old address's pending confirmation link", async () => {
      const zoe = await signup("zoe");
      expect(await M.EmailVerification.countDocuments({ user: zoe.user.id })).toBe(1);
      await requested(zoe).then(confirm);
      expect(await M.EmailVerification.countDocuments({ user: zoe.user.id })).toBe(0);
    });

    it("tells the old address, with a way back that is good for a week, and keeps only its hash", async () => {
      const zoe = await signup("zoe");
      const undo = await changed(zoe);
      const mail = mailTo("zoe@example.com", /was changed/)[0];
      expect(mail.text).toContain("n**@e******.com");
      expect(mail.text).not.toContain("new@example.com");
      expect(mail.text).toMatch(/\/undo-email-change#token=[a-f0-9]{64}/);
      expect(mail.text).toMatch(/within 7 days/);
      const row = await M.EmailChange.findOne().lean();
      expect(row).toMatchObject({ kind: "revertible", oldEmail: "zoe@example.com", newEmail: "new@example.com", tokenHash: sha(undo) });
      expect(JSON.stringify(row)).not.toContain(undo);
      const days = (row.expireAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);
    });

    it("works once, and the link is no good again", async () => {
      const zoe = await signup("zoe");
      const token = await requested(zoe);
      expect((await confirm(token)).status).toBe(204);
      expect((await confirm(token)).status).toBe(400);
    });

    it("refuses an old, forged, made-up or malformed link, and counts the tries", async () => {
      const zoe = await signup("zoe");
      const token = await requested(zoe);
      await M.EmailChange.updateOne({}, { expireAt: new Date(Date.now() - 1000) });
      for (const bad of [token, "f".repeat(64), "short", "", null, 123, { $ne: "" }, "x".repeat(300), undefined]) {
        const res = await request(app).post("/api/auth/email/confirm").send({ token: bad });
        expect(res.status, String(bad).slice(0, 20)).toBe(400);
        expect(res.body.error).toBe("This link is invalid or has expired");
      }
      expect((await M.User.findOne({ username: "zoe" })).email).toBe("zoe@example.com");
    });

    it("stops one address guessing at links after twenty wrong tries", async () => {
      await M.RateLimitHit.insertMany(Array.from({ length: 20 }, () => ({ key: "email-change-link:203.0.113.9", at: new Date(), expireAt: new Date(Date.now() + 900_000) })));
      const res = await request(app).post("/api/auth/email/confirm").set("x-vercel-forwarded-for", "203.0.113.9").send({ token: "f".repeat(64) });
      expect(res.status).toBe(429);
      expect((await request(app).post("/api/auth/email/confirm").send({ token: "f".repeat(64) })).status).toBe(400);
    });

    it("won't take an address that someone else has signed up with in the meantime", async () => {
      const zoe = await signup("zoe");
      const token = await requested(zoe);
      await signup("new");
      const res = await confirm(token);
      expect(res.status).toBe(409);
      expect((await M.User.findOne({ username: "zoe" })).email).toBe("zoe@example.com");
      expect(await M.EmailChange.countDocuments()).toBe(0);
    });

    it("won't apply if the account's email changed some other way since the request", async () => {
      const zoe = await signup("zoe");
      const token = await requested(zoe);
      await M.User.updateOne({ username: "zoe" }, { email: "elsewhere@example.com" });
      expect((await confirm(token)).status).toBe(400);
      expect((await M.User.findOne({ username: "zoe" })).email).toBe("elsewhere@example.com");
    });

    it("doesn't apply to a suspended account", async () => {
      const zoe = await signup("zoe");
      const token = await requested(zoe);
      await M.User.updateOne({ username: "zoe" }, { suspendedAt: new Date() });
      expect((await confirm(token)).status).toBe(400);
      expect((await M.User.findOne({ username: "zoe" })).email).toBe("zoe@example.com");
    });

    it("the undo link can't be used to confirm, and the confirm link can't be used to undo", async () => {
      const zoe = await signup("zoe");
      const confirmToken = await requested(zoe);
      expect((await revert(confirmToken)).status).toBe(400); // still pending: nothing to undo
      expect((await confirm(confirmToken)).status).toBe(204);
      const undo = tokenIn(mailTo("zoe@example.com", /was changed/)[0]);
      expect((await confirm(undo)).status).toBe(400);
    });
  });

  describe("undoing it from the old address", () => {
    it("puts the old address back, signs every device out, and cancels any password reset already on its way", async () => {
      const zoe = await signup("zoe");
      const thief = request.agent(app);
      await thief.post("/api/auth/login").send({ email: "zoe@example.com", password: PASSWORD });
      const undo = await changed(zoe);
      // someone who now holds the new address asks for a password reset
      await M.PasswordReset.create({ user: zoe.user.id, tokenHash: sha("reset-link"), expireAt: new Date(Date.now() + 600_000) });
      expect((await thief.get("/api/auth/me")).status).toBe(200);

      const res = await revert(undo);
      expect(res.status).toBe(204);
      expect(res.headers["set-cookie"]).toBeUndefined();
      const user = await M.User.findOne({ username: "zoe" });
      expect(user.email).toBe("zoe@example.com");
      expect(user.emailVerified).toBe(true);
      expect((await thief.get("/api/auth/me")).status).toBe(401);
      expect((await zoe.agent.get("/api/auth/me")).status).toBe(401);
      expect(await M.Session.countDocuments({ user: zoe.user.id })).toBe(0);
      expect(await M.PasswordReset.countDocuments({ user: zoe.user.id })).toBe(0);
      expect(await M.EmailChange.countDocuments({ user: zoe.user.id })).toBe(0);
      expect((await login("new@example.com")).status).toBe(401);
      await vi.waitFor(() => expect(mailTo("zoe@example.com", /put back/)).toHaveLength(1));
      expect(mailTo("zoe@example.com", /put back/)[0].text).toMatch(/Forgot password/);
    });

    it("works once, and not after a week", async () => {
      const zoe = await signup("zoe");
      const undo = await changed(zoe);
      expect((await revert(undo)).status).toBe(204);
      expect((await revert(undo)).status).toBe(400);

      const sam = await signup("sam");
      const token = await requested(sam, "samnew@example.com");
      await confirm(token);
      await M.EmailChange.updateOne({ user: sam.user.id }, { expireAt: new Date(Date.now() - 1000) });
      const mail = mailTo("sam@example.com", /was changed/)[0];
      expect((await revert(tokenIn(mail))).status).toBe(400);
      expect((await M.User.findOne({ username: "sam" })).email).toBe("samnew@example.com");
    });

    it("refuses made-up and malformed links", async () => {
      for (const bad of ["f".repeat(64), "short", "", null, { $ne: "" }, "x".repeat(300)]) {
        expect((await revert(bad)).status, String(bad).slice(0, 20)).toBe(400);
      }
    });

    it("can't put the address back if someone else has since signed up with it", async () => {
      const zoe = await signup("zoe");
      const undo = await changed(zoe);
      await M.User.create({ email: "zoe@example.com", username: "zoe2", displayName: "z2", passwordHash: "x" });
      const res = await revert(undo);
      expect(res.status).toBe(409);
      expect((await M.User.findOne({ username: "zoe" })).email).toBe("new@example.com");
    });

    it("doesn't touch two-step sign-in (so the undo link can't be used to get round it)", async () => {
      const zoe = await signup("zoe");
      const setup = await zoe.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD });
      await zoe.agent.post("/api/auth/2fa/enable").send({ code: codeForStep(setup.body.secret, stepAt()) });
      await M.User.updateOne({ username: "zoe" }, { "twoFactor.lastStep": 0 });
      expect((await ask(zoe, "new@example.com")).status).toBe(401); // asking needs a code, and none was given
      await M.User.updateOne({ username: "zoe" }, { "twoFactor.lastStep": 0 });
      expect((await ask(zoe, "new@example.com", { code: codeForStep(setup.body.secret, stepAt()) })).status).toBe(204);
      await vi.waitFor(() => expect(mailTo("new@example.com", /Confirm your new/)).toHaveLength(1));
      await confirm(tokenIn(mailTo("new@example.com", /Confirm your new/)[0]));
      await vi.waitFor(() => expect(mailTo("zoe@example.com", /was changed/)).toHaveLength(1));
      expect((await revert(tokenIn(mailTo("zoe@example.com", /was changed/)[0]))).status).toBe(204);
      const user = await M.User.findOne({ username: "zoe" });
      expect(user.twoFactor.enabled).toBe(true);
      const again = await login("zoe@example.com");
      expect(again.body.twoFactorRequired).toBe(true);
    });
  });

  it("is the person's own and goes with the account, and none of it shows in /me or the profile", async () => {
    const zoe = await signup("zoe");
    const sam = await signup("sam");
    await requested(zoe, "zoenew@example.com");
    await requested(sam, "samnew@example.com");
    expect(await M.EmailChange.countDocuments()).toBe(2);
    expect(JSON.stringify((await zoe.agent.get("/api/auth/me")).body)).not.toMatch(/tokenHash|oldEmail|newEmail|zoenew|samnew/);
    expect(JSON.stringify((await request(app).get("/api/profiles/zoe")).body)).not.toMatch(/tokenHash|oldEmail|newEmail|zoenew/);
    expect((await zoe.agent.delete("/api/profiles/me").send({ password: PASSWORD })).status).toBe(204);
    expect(await M.EmailChange.countDocuments({ user: zoe.user.id })).toBe(0);
    expect(await M.EmailChange.countDocuments({ user: sam.user.id })).toBe(1);
  });
});
