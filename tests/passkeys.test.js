import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { SoftAuthenticator } from "./helpers/softAuthenticator.js";
import { codeForStep, stepAt } from "../utils/totp.js";
import { primaryClientUrl } from "../utils/origins.js";

// Mail is captured instead of sent.
const outbox = [];
vi.mock("../utils/mailer.js", () => ({
  mailAvailable: () => true,
  sendMail: vi.fn(async (mail) => {
    outbox.push(mail);
    return { sent: true };
  }),
}));

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

describe("passkeys", () => {
  let app;
  let M;
  let rpId;
  let MAX_PASSKEYS;
  let origin; // the site's own address, known once the environment is loaded

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ rpId, MAX_PASSKEYS } = await import("../routes/passkeys.routes.js"));
    origin = primaryClientUrl();
    M = {
      User: (await import("../models/User.js")).User,
      Passkey: (await import("../models/Passkey.js")).Passkey,
      PasskeyChallenge: (await import("../models/PasskeyChallenge.js")).PasskeyChallenge,
      Session: (await import("../models/Session.js")).Session,
      PasswordReset: (await import("../models/PasswordReset.js")).PasswordReset,
      EmailChange: (await import("../models/EmailChange.js")).EmailChange,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
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
  const notices = (re) => outbox.filter((m) => re.test(m.subject));
  const phone = () => new SoftAuthenticator({ rpId: rpId(), origin });
  async function signup(name) {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: PASSWORD, displayName: name });
    expect(res.status).toBe(201);
    return { agent, user: res.body.user };
  }
  const options = (me, body = { password: PASSWORD }) => me.agent.post("/api/auth/passkeys/register/options").set("Origin", origin).send(body);
  const verify = (me, response, name) => me.agent.post("/api/auth/passkeys/register/verify").set("Origin", origin).send({ response, ...(name ? { name } : {}) });
  /** Adds a passkey the way a person does, and returns the authenticator that holds it. */
  async function addPasskey(me, name, device = phone()) {
    const opts = await options(me);
    expect(opts.status, JSON.stringify(opts.body)).toBe(200);
    const done = await verify(me, device.create(opts.body), name);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    return { device, key: done.body.passkey };
  }
  const loginOptions = () => request(app).post("/api/auth/passkeys/login/options").set("Origin", origin).send({});
  const loginVerify = (response, headers = {}) => request(app).post("/api/auth/passkeys/login/verify").set("Origin", origin).set(headers).send({ response });
  /** Signs in with a passkey the way the browser does: options, then the device's answer. */
  async function signIn(device, extra = {}, headers = {}) {
    const opts = await loginOptions();
    expect(opts.status).toBe(200);
    return loginVerify(device.get(opts.body, extra), headers);
  }

  describe("adding one", () => {
    it("needs a sign-in, the password and the site's own address", async () => {
      expect((await request(app).post("/api/auth/passkeys/register/options").send({ password: PASSWORD })).status).toBe(401);
      expect((await request(app).get("/api/auth/passkeys")).status).toBe(401);
      const zoe = await signup("zoe");
      expect((await options(zoe, {})).status).toBe(400);
      expect((await options(zoe, { password: "wrong-wrong" })).status).toBe(403);
      // an address that isn't one of the site's is stopped by the site-wide origin check before this route sees it
      expect((await zoe.agent.post("/api/auth/passkeys/register/options").set("Origin", "https://evil.example").send({ password: PASSWORD })).status).toBe(403);
      // one of the site's own addresses that the passkeys aren't made for (such as the original *.vercel.app one) is told so
      const saved = process.env.CLIENT_URL;
      process.env.CLIENT_URL = `${origin},https://other-address.vercel.app`;
      try {
        const elsewhere = await zoe.agent.post("/api/auth/passkeys/register/options").set("Origin", "https://other-address.vercel.app").send({ password: PASSWORD });
        expect(elsewhere.status).toBe(400);
        expect(elsewhere.body.code).toBe("passkey_wrong_site");
        expect(elsewhere.body.error).toContain(rpId());
        expect((await request(app).post("/api/auth/passkeys/login/options").set("Origin", "https://other-address.vercel.app").send({})).status).toBe(400);
      } finally {
        process.env.CLIENT_URL = saved;
      }
      expect(await M.PasskeyChallenge.countDocuments()).toBe(0);
    });

    it("counts wrong passwords and stops after five", async () => {
      const zoe = await signup("zoe");
      for (let i = 0; i < 5; i++) expect((await options(zoe, { password: "wrong-wrong" })).status).toBe(403);
      const blocked = await options(zoe);
      expect(blocked.status).toBe(429);
      expect(blocked.headers["retry-after"]).toBeTruthy();
    });

    it("asks the device for a key that needs the person (fingerprint, face or PIN) and can be found again from the site alone", async () => {
      const zoe = await signup("zoe");
      const res = await options(zoe);
      expect(res.status).toBe(200);
      expect(res.body.rp).toEqual({ name: "CreativesSelect", id: rpId() });
      expect(res.body.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
      expect(res.body.attestation).toBe("none");
      expect(res.body.challenge.length).toBeGreaterThan(20);
      expect(res.body.user.name).toBe("zoe");
      expect(Buffer.from(res.body.user.id, "base64url").toString()).toBe(zoe.user.id);
      expect(res.body.pubKeyCredParams.map((p) => p.alg).sort()).toEqual([-257, -7]);
      expect(await M.PasskeyChallenge.countDocuments({ purpose: "register", user: zoe.user.id })).toBe(1);
    });

    it("stores only the public key, names it, and tells the owner by email", async () => {
      const zoe = await signup("zoe");
      const { key } = await addPasskey(zoe, "  My iPhone ");
      expect(key).toMatchObject({ name: "My iPhone", synced: false });
      const stored = await M.Passkey.findOne().lean();
      expect(stored.credentialId).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(stored.publicKey.length).toBeGreaterThan(40);
      expect(Object.keys(stored).sort()).toEqual(["__v", "_id", "backedUp", "counter", "createdAt", "credentialId", "deviceType", "lastUsedAt", "name", "publicKey", "transports", "updatedAt", "user"].sort());
      await vi.waitFor(() => expect(notices(/passkey was added/)).toHaveLength(1));
      expect(notices(/passkey was added/)[0].to).toBe("zoe@example.com");
      expect(notices(/passkey was added/)[0].text).toContain("My iPhone");
      expect(notices(/passkey was added/)[0].text).toMatch(/change your password right away/);
    });

    it("gives it a plain name when none is chosen, and shows a synced one as synced", async () => {
      const zoe = await signup("zoe");
      expect((await addPasskey(zoe)).key.name).toBe("Passkey 1");
      const synced = await addPasskey(zoe, undefined, new SoftAuthenticator({ rpId: rpId(), origin, synced: true }));
      expect(synced.key).toMatchObject({ name: "Passkey 2", synced: true, backedUp: true });
    });

    it("refuses a name that is too long or isn't text", async () => {
      const zoe = await signup("zoe");
      const opts = await options(zoe);
      const response = phone().create(opts.body);
      expect((await verify(zoe, response, "x".repeat(41))).status).toBe(400);
      expect((await zoe.agent.post("/api/auth/passkeys/register/verify").set("Origin", origin).send({ response, name: { a: 1 } })).status).toBe(400);
      expect(await M.Passkey.countDocuments()).toBe(0);
    });

    it("with two-step sign-in on, also needs a code", async () => {
      const zoe = await signup("zoe");
      const setup = await zoe.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD });
      await zoe.agent.post("/api/auth/2fa/enable").send({ code: codeForStep(setup.body.secret, stepAt()) });
      const without = await options(zoe);
      expect(without.status).toBe(401);
      expect(without.body.code).toBe("second_step_needed");
      expect((await options(zoe, { password: PASSWORD, code: "000000" })).status).toBe(401);
      await M.User.updateOne({ username: "zoe" }, { "twoFactor.lastStep": 0 });
      expect((await options(zoe, { password: PASSWORD, code: codeForStep(setup.body.secret, stepAt()) })).status).toBe(200);
    });

    it("stops at ten", async () => {
      const zoe = await signup("zoe");
      for (let i = 0; i < MAX_PASSKEYS; i++) await addPasskey(zoe);
      const more = await options(zoe);
      expect(more.status).toBe(400);
      expect(more.body.error).toMatch(/up to 10/);
    });

    it("lists the ones already held so the same device isn't added twice", async () => {
      const zoe = await signup("zoe");
      const { key } = await addPasskey(zoe);
      const stored = await M.Passkey.findOne({ user: zoe.user.id });
      const again = await options(zoe);
      expect(again.body.excludeCredentials.map((c) => c.id)).toEqual([stored.credentialId]);
      expect(key.id).toBeTruthy();
    });
  });

  describe("what the server will not accept when adding one", () => {
    async function attempt(mutate, { expected = 400 } = {}) {
      const zoe = await signup("zoe");
      const opts = await options(zoe);
      const device = phone();
      const response = mutate(device, opts.body);
      const res = await verify(zoe, response);
      expect(res.status, JSON.stringify(res.body)).toBe(expected);
      expect(await M.Passkey.countDocuments()).toBe(0);
      return res;
    }

    it("an answer for a different challenge, or one that was never given", async () => {
      const res = await attempt((d, o) => d.create(o, { challenge: "dGhpcy1pcy1ub3QtdGhlLWNoYWxsZW5nZQ" }));
      expect(res.body.code).toBe("challenge_expired");
    });

    it("an answer made for another site's address", async () => {
      await attempt((d, o) => d.create(o, { origin: "https://evil.example" }));
    });

    it("an answer made for another domain", async () => {
      await attempt((d, o) => d.create(o, { rpId: "evil.example" }));
    });

    it("a device that didn't check the person", async () => {
      await attempt((_, o) => new SoftAuthenticator({ rpId: rpId(), origin, userVerified: false }).create(o));
    });

    it("garbage, missing parts, and the wrong kinds of things", async () => {
      const zoe = await signup("zoe");
      await options(zoe);
      for (const bad of [{}, { id: "x" }, { id: "x", rawId: "x", type: "public-key", response: {} }, { id: "x", rawId: "x", type: "password", response: { clientDataJSON: "e30" } }, { id: "x".repeat(2000), rawId: "x", type: "public-key", response: {} }, "text", null, [], { id: 1, rawId: 1, type: "public-key", response: "no" }]) {
        const res = await zoe.agent.post("/api/auth/passkeys/register/verify").set("Origin", origin).send({ response: bad });
        expect(res.status, JSON.stringify(bad)?.slice(0, 40)).toBe(400);
      }
      expect(await M.Passkey.countDocuments()).toBe(0);
    });

    it("the same answer twice: a challenge works once", async () => {
      const zoe = await signup("zoe");
      const opts = await options(zoe);
      const response = phone().create(opts.body);
      expect((await verify(zoe, response)).status).toBe(201);
      const again = await verify(zoe, response);
      expect(again.status).toBe(400);
      expect(await M.Passkey.countDocuments()).toBe(1);
    });

    it("a challenge that has run out", async () => {
      const zoe = await signup("zoe");
      const opts = await options(zoe);
      await M.PasskeyChallenge.updateOne({}, { expireAt: new Date(Date.now() - 1000) });
      const res = await verify(zoe, phone().create(opts.body));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("challenge_expired");
    });

    it("someone else's challenge", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      const opts = await options(zoe);
      const res = await verify(sam, phone().create(opts.body));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("challenge_expired");
      expect(await M.Passkey.countDocuments()).toBe(0);
    });

    it("a challenge meant for signing in, used to add one", async () => {
      const zoe = await signup("zoe");
      const opts = await loginOptions();
      const res = await verify(zoe, phone().create({ ...opts.body, user: { id: Buffer.from(zoe.user.id).toString("base64url") } }));
      expect(res.status).toBe(400);
    });

    it("needs the sign-in too", async () => {
      const zoe = await signup("zoe");
      const opts = await options(zoe);
      const res = await request(app).post("/api/auth/passkeys/register/verify").set("Origin", origin).send({ response: phone().create(opts.body) });
      expect(res.status).toBe(401);
    });
  });

  describe("managing them", () => {
    it("lists only the person's own, with nothing that could be used to sign in", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      await addPasskey(zoe, "Zoe's phone");
      await addPasskey(sam, "Sam's phone");
      const list = await zoe.agent.get("/api/auth/passkeys");
      expect(list.body.passkeys).toHaveLength(1);
      expect(list.body.passkeys[0].name).toBe("Zoe's phone");
      expect(list.body.rpId).toBe(rpId());
      expect(Object.keys(list.body.passkeys[0]).sort()).toEqual(["backedUp", "createdAt", "id", "lastUsedAt", "name", "synced"]);
      expect(JSON.stringify(list.body)).not.toMatch(/publicKey|credentialId|counter/);
    });

    it("renames one, the owner's own only, and checks the name", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      const { key } = await addPasskey(zoe, "Old name");
      expect((await zoe.agent.patch(`/api/auth/passkeys/${key.id}`).send({ name: "New name" })).body.passkey.name).toBe("New name");
      expect((await sam.agent.patch(`/api/auth/passkeys/${key.id}`).send({ name: "Stolen" })).status).toBe(404);
      for (const bad of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(41) }, { name: 5 }, { name: { $ne: 1 } }]) {
        expect((await zoe.agent.patch(`/api/auth/passkeys/${key.id}`).send(bad)).status, JSON.stringify(bad)).toBe(400);
      }
      expect((await zoe.agent.patch("/api/auth/passkeys/not-an-id").send({ name: "x" })).status).toBe(404);
      expect((await M.Passkey.findById(key.id)).name).toBe("New name");
    });

    it("removes one only with the password, the owner's own only, and tells the owner", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      const { key } = await addPasskey(zoe, "Phone");
      expect((await request(app).delete(`/api/auth/passkeys/${key.id}`).send({ password: PASSWORD })).status).toBe(401);
      expect((await zoe.agent.delete(`/api/auth/passkeys/${key.id}`).send({})).status).toBe(400);
      expect((await zoe.agent.delete(`/api/auth/passkeys/${key.id}`).send({ password: "wrong-wrong" })).status).toBe(403);
      expect((await sam.agent.delete(`/api/auth/passkeys/${key.id}`).send({ password: PASSWORD })).status).toBe(404);
      expect(await M.Passkey.countDocuments()).toBe(1);
      expect((await zoe.agent.delete(`/api/auth/passkeys/${key.id}`).send({ password: PASSWORD })).status).toBe(204);
      expect(await M.Passkey.countDocuments()).toBe(0);
      await vi.waitFor(() => expect(notices(/passkey was removed/)).toHaveLength(1));
    });
  });

  describe("signing in with one", () => {
    it("asks the device for whichever key it holds for this site, needing the person", async () => {
      const res = await loginOptions();
      expect(res.status).toBe(200);
      expect(res.body.rpId).toBe(rpId());
      expect(res.body.userVerification).toBe("required");
      expect(res.body.allowCredentials ?? []).toEqual([]);
      expect(await M.PasskeyChallenge.countDocuments({ purpose: "login", user: null })).toBe(1);
    });

    it("signs in with a right answer: a session, the person, and the counter moved on", async () => {
      const zoe = await signup("zoe");
      const { device } = await addPasskey(zoe);
      const agent = request.agent(app);
      const opts = await loginOptions();
      const res = await agent.post("/api/auth/passkeys/login/verify").set("Origin", origin).send({ response: device.get(opts.body) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.user.username).toBe("zoe");
      expect(res.headers["set-cookie"][0]).toMatch(/^token=/);
      expect((await agent.get("/api/auth/me")).status).toBe(200);
      expect((await agent.get("/api/auth/sessions")).body.sessions).toHaveLength(2);
      const stored = await M.Passkey.findOne();
      expect(stored.counter).toBe(1);
      expect(stored.lastUsedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
      // and it can be used again
      expect((await signIn(device)).status).toBe(200);
      expect((await M.Passkey.findOne()).counter).toBe(2);
    });

    it("counts as the second step too: no password and no code are asked for", async () => {
      const zoe = await signup("zoe");
      const { device } = await addPasskey(zoe);
      const setup = await zoe.agent.post("/api/auth/2fa/setup").send({ password: PASSWORD });
      await zoe.agent.post("/api/auth/2fa/enable").send({ code: codeForStep(setup.body.secret, stepAt()) });
      const res = await signIn(device);
      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe("zoe");
      expect(res.body.twoFactorRequired).toBeUndefined();
    });

    it("emails the owner about a sign-in from a browser it hasn't seen, like a password sign-in", async () => {
      const zoe = await signup("zoe");
      const { device } = await addPasskey(zoe);
      outbox.length = 0;
      expect((await signIn(device, {}, { "User-Agent": IPHONE })).status).toBe(200);
      await vi.waitFor(() => expect(notices(/New sign-in/)).toHaveLength(1));
      expect(notices(/New sign-in/)[0].text).toContain("Safari on iPhone");
    });

    it("each sign-in is for the person whose key it was, among several people", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      const z = await addPasskey(zoe);
      const s = await addPasskey(sam);
      expect((await signIn(z.device)).body.user.username).toBe("zoe");
      expect((await signIn(s.device)).body.user.username).toBe("sam");
    });
  });

  describe("what the server will not accept when signing in", () => {
    async function ready() {
      const zoe = await signup("zoe");
      const { device } = await addPasskey(zoe);
      return { zoe, device };
    }
    const refused = (res) => {
      expect(res.status, JSON.stringify(res.body)).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.body.error).toMatch(/passkey didn't work/);
    };

    it("an answer replayed: a challenge works once", async () => {
      const { device } = await ready();
      const opts = await loginOptions();
      const response = device.get(opts.body);
      expect((await loginVerify(response)).status).toBe(200);
      refused(await loginVerify(response));
    });

    it("an answer for a challenge that was never given, or has run out", async () => {
      const { device } = await ready();
      const opts = await loginOptions();
      refused(await loginVerify(device.get(opts.body, { challenge: "dGhpcy1pcy1ub3QtdGhlLWNoYWxsZW5nZQ" })));
      await M.PasskeyChallenge.updateOne({ purpose: "login" }, { expireAt: new Date(Date.now() - 1000) });
      refused(await loginVerify(device.get(opts.body)));
    });

    it("a challenge from adding a passkey, used to sign in", async () => {
      const zoe = await signup("zoe");
      const opts = await options(zoe);
      const device = phone();
      expect((await verify(zoe, device.create(opts.body))).status).toBe(201);
      const other = await options(zoe);
      refused(await loginVerify(device.get(other.body)));
    });

    it("a passkey the site doesn't know", async () => {
      await ready();
      const stranger = phone();
      const regOpts = (await options(await signup("sam"))).body;
      stranger.create(regOpts); // a key the site never saw
      const opts = await loginOptions();
      refused(await loginVerify(stranger.get(opts.body)));
    });

    it("an answer made for another site's address or another domain", async () => {
      const { device } = await ready();
      refused(await loginVerify(device.get((await loginOptions()).body, { origin: "https://evil.example" })));
      refused(await loginVerify(device.get((await loginOptions()).body, { rpId: "evil.example" })));
    });

    it("a device that didn't check the person", async () => {
      const zoe = await signup("zoe");
      const { device } = await addPasskey(zoe);
      device.userVerified = false;
      refused(await signIn(device));
    });

    it("a signature that isn't the key's: the answer altered, or made with another key", async () => {
      const { device } = await ready();
      const opts = await loginOptions();
      const response = device.get(opts.body);
      const flipped = Buffer.from(response.response.signature, "base64url");
      flipped[flipped.length - 1] ^= 1;
      refused(await loginVerify({ ...response, response: { ...response.response, signature: flipped.toString("base64url") } }));

      const other = await loginOptions();
      const mine = device.get(other.body);
      const forger = phone();
      forger.create((await options(await signup("sam"))).body);
      const forged = forger.get(other.body);
      refused(await loginVerify({ ...mine, response: { ...mine.response, signature: forged.response.signature } }));
    });

    it("a device whose counter went backwards or stood still (a copied key)", async () => {
      const { device } = await ready();
      expect((await signIn(device, { counter: 5 })).status).toBe(200);
      refused(await signIn(device, { counter: 5 }));
      refused(await signIn(device, { counter: 3 }));
      expect((await M.Passkey.findOne()).counter).toBe(5);
      expect((await signIn(device, { counter: 6 })).status).toBe(200);
    });

    it("an answer that says it is for a different account than the key's", async () => {
      const { device } = await ready();
      const other = await signup("sam");
      refused(await signIn(device, { userHandle: Buffer.from(other.user.id).toString("base64url") }));
    });

    it("garbage, and the wrong kinds of things", async () => {
      await ready();
      await loginOptions();
      for (const bad of [{}, { id: "x" }, { id: "x", rawId: "x", type: "public-key", response: {} }, { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "e30" } }, "text", null, [], { id: { $ne: 1 }, rawId: "x", type: "public-key", response: {} }]) {
        const res = await request(app).post("/api/auth/passkeys/login/verify").set("Origin", origin).send({ response: bad });
        // shaped wrongly is a 400; shaped right but not an answer to any challenge is a 401 (and counts against the address)
        expect([400, 401], JSON.stringify(bad)?.slice(0, 40)).toContain(res.status);
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
    });

    it("an account that has been suspended: refused, but only after a real passkey answered", async () => {
      const { device } = await ready();
      await M.User.updateOne({ username: "zoe" }, { suspendedAt: new Date() });
      const res = await signIn(device);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("account_suspended");
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("stops one address after twenty failures", async () => {
      await ready();
      await M.RateLimitHit.insertMany(Array.from({ length: 20 }, () => ({ key: "passkey-login-fail:203.0.113.5", at: new Date(), expireAt: new Date(Date.now() + 900_000) })));
      const res = await request(app).post("/api/auth/passkeys/login/verify").set("Origin", origin).set("x-vercel-forwarded-for", "203.0.113.5").send({ response: { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "e30" } } });
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeTruthy();
    });

    it("limits how many sets of options one address can ask for", async () => {
      await M.RateLimitHit.insertMany(Array.from({ length: 60 }, () => ({ key: "passkey-login-options:203.0.113.6", at: new Date(), expireAt: new Date(Date.now() + 900_000) })));
      const res = await request(app).post("/api/auth/passkeys/login/options").set("Origin", origin).set("x-vercel-forwarded-for", "203.0.113.6").send({});
      expect(res.status).toBe(429);
    });

    it("refuses to hand out options to another site's address", async () => {
      const res = await request(app).post("/api/auth/passkeys/login/options").set("Origin", "https://evil.example").send({});
      expect(res.status).toBe(403); // stopped by the site-wide origin check
    });
  });

  describe("taking an account back", () => {
    it("resetting a forgotten password by email removes every passkey, since someone who got in could have added one", async () => {
      const zoe = await signup("zoe");
      const { device } = await addPasskey(zoe);
      const token = "t".repeat(40);
      await M.PasswordReset.create({ user: zoe.user.id, tokenHash: createHash("sha256").update(token).digest("hex"), expireAt: new Date(Date.now() + 600_000) });
      outbox.length = 0;
      expect((await request(app).post("/api/auth/reset-password").send({ token, newPassword: "a-new-password-5" })).status).toBe(204);
      expect(await M.Passkey.countDocuments({ user: zoe.user.id })).toBe(0);
      refused(await signIn(device));
      await vi.waitFor(() => expect(notices(/password was changed/)).toHaveLength(1));
      expect(notices(/password was changed/)[0].text).toMatch(/passkeys on the account were removed/);

      function refused(res) {
        expect(res.status).toBe(401);
      }
    });

    it("undoing an email change removes them too", async () => {
      const zoe = await signup("zoe");
      await addPasskey(zoe);
      await M.EmailChange.create({ user: zoe.user.id, kind: "revertible", oldEmail: "zoe@example.com", newEmail: "thief@example.com", tokenHash: createHash("sha256").update("u".repeat(40)).digest("hex"), expireAt: new Date(Date.now() + 600_000) });
      await M.User.updateOne({ username: "zoe" }, { email: "thief@example.com" });
      expect((await request(app).post("/api/auth/email/revert").send({ token: "u".repeat(40) })).status).toBe(204);
      expect(await M.Passkey.countDocuments({ user: zoe.user.id })).toBe(0);
    });

    it("changing the password on purpose keeps them (the person is signed in and chose to)", async () => {
      const zoe = await signup("zoe");
      await addPasskey(zoe);
      expect((await zoe.agent.put("/api/auth/password").send({ currentPassword: PASSWORD, newPassword: "a-brand-new-pass-9" })).status).toBe(204);
      expect(await M.Passkey.countDocuments({ user: zoe.user.id })).toBe(1);
    });

    it("deleting the account removes them, and nothing else is touched", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      await addPasskey(zoe);
      await addPasskey(sam);
      await options(zoe);
      expect((await zoe.agent.delete("/api/profiles/me").send({ password: PASSWORD })).status).toBe(204);
      expect(await M.Passkey.countDocuments({ user: zoe.user.id })).toBe(0);
      expect(await M.Passkey.countDocuments({ user: sam.user.id })).toBe(1);
      expect(await M.PasskeyChallenge.countDocuments({ user: zoe.user.id })).toBe(0);
    });
  });

  it("keeps all of it out of /me and the public profile", async () => {
    const zoe = await signup("zoe");
    await addPasskey(zoe);
    const mine = JSON.stringify((await zoe.agent.get("/api/auth/me")).body);
    const theirs = JSON.stringify((await request(app).get("/api/profiles/zoe")).body);
    for (const body of [mine, theirs]) expect(body).not.toMatch(/passkey|credentialId|publicKey/i);
  });
});
