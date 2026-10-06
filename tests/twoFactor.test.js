import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { codeForStep, stepAt } from "../utils/totp.js";

// Mail is captured instead of sent.
const outbox = [];
vi.mock("../utils/mailer.js", () => ({
  mailAvailable: () => true,
  sendMail: vi.fn(async (mail) => {
    outbox.push(mail);
    return { sent: true };
  }),
}));

describe("two-step sign-in", () => {
  let app;
  let M;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      Session: (await import("../models/Session.js")).Session,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
      PasswordReset: (await import("../models/PasswordReset.js")).PasswordReset,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    outbox.length = 0;
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const PASSWORD = "password-123";
  const notices = () => outbox.filter((m) => /Two-step/.test(m.subject));

  async function signup(name) {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: PASSWORD, displayName: name });
    expect(res.status).toBe(201);
    return { agent, user: res.body.user };
  }
  /** Turns it on the way a person would, and returns what they would keep: the secret and the recovery codes. */
  async function turnOn(name) {
    const me = await signup(name);
    const setup = await me.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD });
    expect(setup.status).toBe(200);
    // The first code can be one step ahead, so that logging in right afterwards has an unused one in range.
    const enable = await me.agent.post("/api/auth/2fa/enable").send({ code: codeForStep(setup.body.secret, stepAt()) });
    expect(enable.status, JSON.stringify(enable.body)).toBe(200);
    return { ...me, secret: setup.body.secret, codes: enable.body.recoveryCodes };
  }
  /** A code that is accepted now: the newest step, which hasn't been used. */
  async function freshCode(me) {
    await M.User.updateOne({ _id: me.user.id }, { "twoFactor.lastStep": 0 });
    return codeForStep(me.secret, stepAt());
  }
  const login = (name, password = PASSWORD) => request(app).post("/api/auth/login").send({ email: `${name}@example.com`, password });
  const finish = (challenge, code) => request(app).post("/api/auth/login/2fa").send({ challenge, code });
  async function challengeFor(name) {
    const res = await login(name);
    expect(res.body.twoFactorRequired).toBe(true);
    return res.body.challenge;
  }

  describe("turning it on", () => {
    it("is off to begin with, and asking needs a sign-in", async () => {
      const me = await signup("zoe");
      expect((await me.agent.get("/api/auth/2fa")).body).toEqual({ enabled: false, recoveryCodesLeft: 0 });
      for (const [method, path] of [["get", "/api/auth/2fa"], ["post", "/api/auth/2fa/setup"], ["post", "/api/auth/2fa/enable"], ["post", "/api/auth/2fa/disable"], ["post", "/api/auth/2fa/recovery-codes"]]) {
        expect((await request(app)[method](path).send({})).status, path).toBe(401);
      }
    });

    it("needs the password to start, and counts wrong ones", async () => {
      const me = await signup("zoe");
      const wrong = await me.agent.post("/api/auth/2fa/setup").send({ password: "not-my-password" });
      expect(wrong.status).toBe(403);
      expect((await me.agent.post("/api/auth/2fa/setup").send({})).status).toBe(400);
      expect(await M.User.findById(me.user.id).then((u) => u.twoFactor.pendingSecret)).toBeNull();
      await M.RateLimitHit.insertMany(Array.from({ length: 5 }, () => ({ key: `two-step-password:${me.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 900_000) })));
      expect((await me.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD })).status).toBe(429);
    });

    it("gives a secret and the address for an app, and keeps the secret sealed and not yet in use", async () => {
      const me = await signup("zoe");
      const res = await me.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(res.body.otpauthUrl).toContain(`secret=${res.body.secret}`);
      expect(res.body.otpauthUrl).toContain("issuer=CreativesSelect");
      expect(res.body.otpauthUrl).toContain("zoe%40example.com");
      const stored = await M.User.findById(me.user.id).lean();
      expect(stored.twoFactor.enabled).toBe(false);
      expect(stored.twoFactor.pendingSecret).toBeTruthy();
      expect(JSON.stringify(stored.twoFactor)).not.toContain(res.body.secret);
      // and logging in is unchanged until it is confirmed
      expect((await login("zoe")).body.twoFactorRequired).toBeUndefined();
    });

    it("turns on only when the app's code is right, and a wrong one changes nothing", async () => {
      const me = await signup("zoe");
      const { body } = await me.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD });
      const wrong = await me.agent.post("/api/auth/2fa/enable").send({ code: "000000" === codeForStep(body.secret, stepAt()) ? "111111" : "000000" });
      expect(wrong.status).toBe(400);
      expect((await me.agent.post("/api/auth/2fa/enable").send({ code: "abc" })).status).toBe(400);
      expect((await me.agent.get("/api/auth/2fa")).body.enabled).toBe(false);
      expect(notices()).toHaveLength(0);

      const right = await me.agent.post("/api/auth/2fa/enable").send({ code: codeForStep(body.secret, stepAt()) });
      expect(right.status).toBe(200);
      expect((await me.agent.get("/api/auth/2fa")).body).toEqual({ enabled: true, recoveryCodesLeft: 8 });
    });

    it("shows eight recovery codes once, and keeps only their hashes, with the secret sealed", async () => {
      const me = await turnOn("zoe");
      expect(me.codes).toHaveLength(8);
      for (const code of me.codes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      const stored = await M.User.findById(me.user.id).lean();
      expect(stored.twoFactor.enabled).toBe(true);
      expect(stored.twoFactor.pendingSecret).toBeNull();
      expect(stored.twoFactor.recoveryHashes).toHaveLength(8);
      const dump = JSON.stringify(stored.twoFactor);
      expect(dump).not.toContain(me.secret);
      for (const code of me.codes) expect(dump).not.toContain(code.replace("-", ""));
      // the list can't be had again: only how many are left
      expect(JSON.stringify((await me.agent.get("/api/auth/2fa")).body)).not.toMatch(/[a-z2-9]{5}-[a-z2-9]{5}/);
    });

    it("emails the owner that it was turned on", async () => {
      await turnOn("zoe");
      await vi.waitFor(() => expect(notices()).toHaveLength(1));
      expect(notices()[0]).toMatchObject({ to: "zoe@example.com", subject: "Two-step sign-in was turned on" });
      expect(notices()[0].text).toMatch(/change your password/);
    });

    it("can't be turned on twice, or confirmed without asking for a secret first", async () => {
      const on = await turnOn("zoe");
      expect((await on.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD })).status).toBe(409);
      expect((await on.agent.post("/api/auth/2fa/enable").send({ code: await freshCode(on) })).status).toBe(409);
      const other = await signup("sam");
      expect((await other.agent.post("/api/auth/2fa/enable").send({ code: "123456" })).status).toBe(400);
    });

    it("a new secret asked for replaces the one waiting, so only the newest can be confirmed", async () => {
      const me = await signup("zoe");
      const first = (await me.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD })).body;
      const second = (await me.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD })).body;
      expect(second.secret).not.toBe(first.secret);
      expect((await me.agent.post("/api/auth/2fa/enable").send({ code: codeForStep(first.secret, stepAt()) })).status).toBe(400);
      expect((await me.agent.post("/api/auth/2fa/enable").send({ code: codeForStep(second.secret, stepAt()) })).status).toBe(200);
    });

    it("counts wrong confirmation codes, and stops after five", async () => {
      const me = await signup("zoe");
      const { body } = await me.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD });
      const good = codeForStep(body.secret, stepAt());
      const wrong = good === "123456" ? "654321" : "123456";
      for (let i = 0; i < 5; i++) expect((await me.agent.post("/api/auth/2fa/enable").send({ code: wrong })).status).toBe(400);
      expect((await me.agent.post("/api/auth/2fa/enable").send({ code: good })).status).toBe(429);
    });
  });

  describe("logging in", () => {
    it("with a right password asks for a code, without signing anyone in", async () => {
      await turnOn("zoe");
      const res = await login("zoe");
      expect(res.status).toBe(200);
      expect(res.body.twoFactorRequired).toBe(true);
      expect(typeof res.body.challenge).toBe("string");
      expect(res.body.user).toBeUndefined();
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(await M.Session.countDocuments({ user: (await M.User.findOne({ username: "zoe" }))._id })).toBe(1); // only the one from signing up
    });

    it("doesn't reveal that it is on to someone who has the wrong password", async () => {
      await turnOn("zoe");
      await signup("sam");
      const withIt = await login("zoe", "wrong-password");
      const without = await login("sam", "wrong-password");
      expect(withIt.status).toBe(401);
      expect(withIt.body).toEqual(without.body);
      expect(withIt.body.challenge).toBeUndefined();
      expect((await login("nobody")).body).toEqual(without.body);
    });

    it("signs in with the right code, starts a session that is listed, and says how many recovery codes are left", async () => {
      const zoe = await turnOn("zoe");
      const challenge = await challengeFor("zoe");
      const agent = request.agent(app);
      const res = await agent.post("/api/auth/login/2fa").send({ challenge, code: await freshCode(zoe) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.user.username).toBe("zoe");
      expect(res.body.recoveryCodesLeft).toBe(8);
      expect((await agent.get("/api/auth/me")).status).toBe(200);
      expect((await agent.get("/api/auth/sessions")).body.sessions).toHaveLength(2);
    });

    it("takes the code with spaces in it, as an app shows it", async () => {
      const zoe = await turnOn("zoe");
      const code = await freshCode(zoe);
      expect((await finish(await challengeFor("zoe"), `${code.slice(0, 3)} ${code.slice(3)}`)).status).toBe(200);
    });

    it("refuses a wrong code, and a code with no challenge or a challenge with no code", async () => {
      const zoe = await turnOn("zoe");
      const challenge = await challengeFor("zoe");
      const good = await freshCode(zoe);
      const wrong = good === "123456" ? "654321" : "123456";
      const res = await finish(challenge, wrong);
      expect(res.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect((await finish(challenge, "")).status).toBe(400);
      expect((await finish("", good)).status).toBe(400);
      expect((await request(app).post("/api/auth/login/2fa").send({ code: good })).status).toBe(400);
      expect((await request(app).post("/api/auth/login/2fa").send({ challenge, code: { $ne: "" } })).status).toBe(400);
      expect((await finish(challenge, good)).status).toBe(200); // the right one still works after the wrong ones
    });

    it("never accepts the same code twice, or an earlier one", async () => {
      const zoe = await turnOn("zoe");
      const code = await freshCode(zoe);
      expect((await finish(await challengeFor("zoe"), code)).status).toBe(200);
      const again = await finish(await challengeFor("zoe"), code);
      expect(again.status).toBe(401);
      // one step earlier than the one just used is no good either
      expect((await finish(await challengeFor("zoe"), codeForStep(zoe.secret, stepAt() - 1))).status).toBe(401);
    });

    it("lets only one of two requests carrying the same code succeed", async () => {
      const zoe = await turnOn("zoe");
      const code = await freshCode(zoe);
      const [a, b] = [await challengeFor("zoe"), await challengeFor("zoe")];
      const results = await Promise.all([finish(a, code), finish(b, code)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it("stops after five wrong codes, even for the right one, and the limit is for that person only", async () => {
      const zoe = await turnOn("zoe");
      const sam = await turnOn("sam");
      const challenge = await challengeFor("zoe");
      const good = await freshCode(zoe);
      const wrong = good === "123456" ? "654321" : "123456";
      for (let i = 0; i < 5; i++) expect((await finish(challenge, wrong)).status).toBe(401);
      const blocked = await finish(challenge, good);
      expect(blocked.status).toBe(429);
      expect(blocked.headers["retry-after"]).toBeTruthy();
      expect((await finish(await challengeFor("sam"), await freshCode(sam))).status).toBe(200);
    });

    it("limits one address too, whoever it is guessing at", async () => {
      const zoe = await turnOn("zoe");
      const sam = await turnOn("sam");
      const here = { "x-vercel-forwarded-for": "203.0.113.7" };
      const wrong = (await freshCode(zoe)) === "123456" ? "654321" : "123456";
      // thirty wrong guesses from one address, spread over different people's notes (so no one person is limited)
      await M.RateLimitHit.insertMany(Array.from({ length: 30 }, () => ({ key: "two-step-code-ip:203.0.113.7", at: new Date(), expireAt: new Date(Date.now() + 900_000) })));
      const blocked = await request(app).post("/api/auth/login/2fa").set(here).send({ challenge: await challengeFor("sam"), code: await freshCode(sam) });
      expect(blocked.status).toBe(429);
      // someone elsewhere is not held up
      expect((await finish(await challengeFor("zoe"), await freshCode(zoe))).status).toBe(200);
      expect(wrong).not.toBe("");
    });

    it("a recovery code works once, however it is typed, and the count goes down", async () => {
      const zoe = await turnOn("zoe");
      const [first, second] = zoe.codes;
      const typed = ` ${first.toUpperCase().replace("-", " ")} `;
      const ok = await finish(await challengeFor("zoe"), typed);
      expect(ok.status).toBe(200);
      expect(ok.body.recoveryCodesLeft).toBe(7);
      expect((await finish(await challengeFor("zoe"), first)).status).toBe(401);
      const next = await finish(await challengeFor("zoe"), second.replace("-", ""));
      expect(next.status).toBe(200);
      expect(next.body.recoveryCodesLeft).toBe(6);
    });

    it("a made-up recovery code, or one of the wrong shape, is refused and counted like any wrong code", async () => {
      await turnOn("zoe");
      const challenge = await challengeFor("zoe");
      for (const bad of ["abcde-fghjk", "aaaaa-aaaaa", "12345", "1234567", "hello"]) expect((await finish(challenge, bad)).status, bad).toBe(401);
      expect((await finish(challenge, "%$#@!")).status).toBe(429); // the sixth wrong try
      expect((await finish(challenge, "a".repeat(41))).status).toBe(400); // too long to be a code at all
    });

    it("the note a login gives only works for the second step: not as a sign-in, not forged, not old, not for someone else", async () => {
      const zoe = await turnOn("zoe");
      const challenge = await challengeFor("zoe");
      const code = await freshCode(zoe);
      // used as the sign-in cookie it opens nothing
      expect((await request(app).get("/api/auth/me").set("Cookie", `token=${challenge}`)).status).toBe(401);
      expect((await request(app).get("/api/profiles/zoe").set("Cookie", `token=${challenge}`)).body.user?.email).toBeUndefined();
      // a normal sign-in token can't stand in for it
      const signedIn = jwt.sign({ id: zoe.user.id, username: "zoe", pv: 0 }, process.env.JWT_SECRET);
      expect((await finish(signedIn, code)).body.code).toBe("challenge_expired");
      // forged, expired, garbage
      const forged = jwt.sign({ purpose: "two-step", uid: zoe.user.id, pv: 0 }, "some-other-secret");
      const expired = jwt.sign({ purpose: "two-step", uid: zoe.user.id, pv: 0 }, process.env.JWT_SECRET, { expiresIn: -10 });
      for (const bad of [forged, expired, "garbage", "a.b.c"]) {
        const res = await finish(bad, code);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe("challenge_expired");
      }
      expect((await finish(challenge, code)).status).toBe(200);
    });

    it("the note stops working if the password changes before the code is given", async () => {
      const zoe = await turnOn("zoe");
      const challenge = await challengeFor("zoe");
      await M.User.updateOne({ _id: zoe.user.id }, { passwordChangedAt: new Date() });
      const res = await finish(challenge, await freshCode(zoe));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("challenge_expired");
    });

    it("a note for one person can't finish the sign-in of another, or of someone without it", async () => {
      const zoe = await turnOn("zoe");
      const sam = await signup("sam");
      const forSam = jwt.sign({ purpose: "two-step", uid: sam.user.id, pv: 0 }, process.env.JWT_SECRET, { expiresIn: "5m" });
      expect((await finish(forSam, await freshCode(zoe))).body.code).toBe("challenge_expired"); // sam hasn't turned it on
      const challengeForZoe = await challengeFor("zoe");
      // zoe's note with a code from sam's app (sam has none) is refused too
      expect((await finish(challengeForZoe, "123456")).status).toBe(401);
    });

    it("a suspended account is still told so after the password, and gets no note", async () => {
      await turnOn("zoe");
      await M.User.updateOne({ username: "zoe" }, { suspendedAt: new Date() });
      const res = await login("zoe");
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("account_suspended");
      expect(res.body.challenge).toBeUndefined();
    });

    it("an account suspended after the password was right can't finish", async () => {
      const zoe = await turnOn("zoe");
      const challenge = await challengeFor("zoe");
      await M.User.updateOne({ username: "zoe" }, { suspendedAt: new Date() });
      expect((await finish(challenge, await freshCode(zoe))).status).toBe(401);
    });

    it("resetting the password by email doesn't skip it", async () => {
      const zoe = await turnOn("zoe");
      const token = "r".repeat(40);
      await M.PasswordReset.create({ user: zoe.user.id, tokenHash: (await import("node:crypto")).createHash("sha256").update(token).digest("hex"), expireAt: new Date(Date.now() + 600_000) });
      expect((await request(app).post("/api/auth/reset-password").send({ token, newPassword: "a-new-password-5" })).status).toBe(204);
      const res = await request(app).post("/api/auth/login").send({ email: "zoe@example.com", password: "a-new-password-5" });
      expect(res.body.twoFactorRequired).toBe(true);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("someone without it logs in exactly as before", async () => {
      await signup("sam");
      const res = await login("sam");
      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe("sam");
      expect(res.body.twoFactorRequired).toBeUndefined();
      expect(res.headers["set-cookie"]).toBeTruthy();
    });
  });

  describe("turning it off and getting new recovery codes", () => {
    it("turning it off needs the password and a code, and logging in is then as before", async () => {
      const zoe = await turnOn("zoe");
      expect((await zoe.agent.post("/api/auth/2fa/disable").send({ password: "wrong-pass", code: await freshCode(zoe) })).status).toBe(403);
      expect((await zoe.agent.post("/api/auth/2fa/disable").send({ password: PASSWORD, code: "000000" === (await freshCode(zoe)) ? "111111" : "000000" })).status).toBe(401);
      expect((await zoe.agent.post("/api/auth/2fa/disable").send({ password: PASSWORD })).status).toBe(400);
      expect((await zoe.agent.get("/api/auth/2fa")).body.enabled).toBe(true);

      expect((await zoe.agent.post("/api/auth/2fa/disable").send({ password: PASSWORD, code: await freshCode(zoe) })).status).toBe(204);
      expect((await zoe.agent.get("/api/auth/2fa")).body).toEqual({ enabled: false, recoveryCodesLeft: 0 });
      const stored = await M.User.findById(zoe.user.id).lean();
      expect(stored.twoFactor).toMatchObject({ enabled: false, secret: null, pendingSecret: null, recoveryHashes: [], lastStep: 0 });
      const res = await login("zoe");
      expect(res.body.twoFactorRequired).toBeUndefined();
      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(notices().map((m) => m.subject)).toEqual(["Two-step sign-in was turned on", "Two-step sign-in was turned off"]));
    });

    it("a recovery code can turn it off, for someone who has lost the app", async () => {
      const zoe = await turnOn("zoe");
      expect((await zoe.agent.post("/api/auth/2fa/disable").send({ password: PASSWORD, code: zoe.codes[3] })).status).toBe(204);
      expect((await login("zoe")).body.twoFactorRequired).toBeUndefined();
    });

    it("asking to turn it off when it isn't on says so", async () => {
      const sam = await signup("sam");
      expect((await sam.agent.post("/api/auth/2fa/disable").send({ password: PASSWORD, code: "123456" })).status).toBe(400);
    });

    it("turning it off or getting codes counts wrong passwords and codes, like everywhere else", async () => {
      const zoe = await turnOn("zoe");
      for (let i = 0; i < 5; i++) expect((await zoe.agent.post("/api/auth/2fa/disable").send({ password: PASSWORD, code: "999999" === codeForStep(zoe.secret, stepAt()) ? "888888" : "999999" })).status).toBe(401);
      const blocked = await zoe.agent.post("/api/auth/2fa/recovery-codes").send({ password: PASSWORD, code: await freshCode(zoe) });
      expect(blocked.status).toBe(429);
    });

    it("new recovery codes replace the old ones, which stop working", async () => {
      const zoe = await turnOn("zoe");
      const res = await zoe.agent.post("/api/auth/2fa/recovery-codes").send({ password: PASSWORD, code: await freshCode(zoe) });
      expect(res.status).toBe(200);
      expect(res.body.recoveryCodes).toHaveLength(8);
      expect(res.body.recoveryCodes.some((c) => zoe.codes.includes(c))).toBe(false);
      expect((await zoe.agent.get("/api/auth/2fa")).body.recoveryCodesLeft).toBe(8);
      expect((await finish(await challengeFor("zoe"), zoe.codes[0])).status).toBe(401);
      expect((await finish(await challengeFor("zoe"), res.body.recoveryCodes[0])).status).toBe(200);
    });

    it("getting new codes needs the password and a code too", async () => {
      const zoe = await turnOn("zoe");
      expect((await zoe.agent.post("/api/auth/2fa/recovery-codes").send({ password: "nope-nope", code: await freshCode(zoe) })).status).toBe(403);
      expect((await zoe.agent.post("/api/auth/2fa/recovery-codes").send({ password: PASSWORD })).status).toBe(400);
      expect((await zoe.agent.get("/api/auth/2fa")).body.recoveryCodesLeft).toBe(8);
    });

    it("only affects the person asking", async () => {
      const zoe = await turnOn("zoe");
      const sam = await turnOn("sam");
      await zoe.agent.post("/api/auth/2fa/disable").send({ password: PASSWORD, code: await freshCode(zoe) });
      expect((await sam.agent.get("/api/auth/2fa")).body.enabled).toBe(true);
      expect((await login("sam")).body.twoFactorRequired).toBe(true);
    });
  });

  it("deleting the account takes it with it, and none of it shows in /me or on the profile", async () => {
    const zoe = await turnOn("zoe");
    const me = (await zoe.agent.get("/api/auth/me")).body.user;
    const profile = (await request(app).get("/api/profiles/zoe")).body.user;
    for (const body of [me, profile]) expect(JSON.stringify(body)).not.toMatch(/twoFactor|recoveryHashes|pendingSecret|lastStep|secret/i);
    expect((await zoe.agent.delete("/api/profiles/me").send({ password: PASSWORD })).status).toBe(204);
    expect(await M.User.countDocuments({ username: "zoe" })).toBe(0);
  });
});
