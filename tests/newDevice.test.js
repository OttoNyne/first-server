import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { codeForStep, stepAt } from "../utils/totp.js";
import { MAX_KNOWN_DEVICES } from "../services/sessions.js";

// Mail is captured instead of sent.
const outbox = [];
let mailFails = false;
vi.mock("../utils/mailer.js", () => ({
  mailAvailable: () => true,
  sendMail: vi.fn(async (mail) => {
    if (mailFails) throw new Error("the mail service is down");
    outbox.push(mail);
    return { sent: true };
  }),
}));

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

describe("emails about sign-ins from somewhere new", () => {
  let app;
  let M;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    outbox.length = 0;
    mailFails = false;
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const PASSWORD = "password-123";
  const alerts = (to = "zoe@example.com") => outbox.filter((m) => m.to === to && /New sign-in/.test(m.subject));
  /** Mail is sent after the reply, so look for it, and give "none" a moment to show up if it was wrongly sent. */
  const settle = () => new Promise((r) => setTimeout(r, 150));
  const register = (agent, name = "zoe", ua = CHROME) => agent.post("/api/auth/register").set("User-Agent", ua).send({ email: `${name}@example.com`, username: name, password: PASSWORD, displayName: name });
  const login = (agent, name = "zoe", ua = CHROME, password = PASSWORD) => agent.post("/api/auth/login").set("User-Agent", ua).send({ email: `${name}@example.com`, password });
  const deviceCookie = (res) => (res.headers["set-cookie"] ?? []).find((c) => c.startsWith("device="));

  it("gives each browser that signs in a long-lived private id, apart from the sign-in cookie, and leaves the sign-in cookie first", async () => {
    const res = await register(request(app));
    expect(res.status).toBe(201);
    expect(res.headers["set-cookie"][0]).toMatch(/^token=/);
    const cookie = deviceCookie(res);
    expect(cookie).toMatch(/^device=[a-f0-9]{32};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const maxAge = Number(cookie.match(/Max-Age=(\d+)/)[1]);
    expect(maxAge).toBeGreaterThan(364 * 86_400);
    expect(maxAge).toBeLessThanOrEqual(366 * 86_400);
  });

  it("says nothing when someone signs up, and nothing when they sign in again from the same browser", async () => {
    const agent = request.agent(app);
    await register(agent);
    await settle();
    expect(alerts()).toHaveLength(0);
    expect((await login(agent)).status).toBe(200);
    expect((await login(agent)).status).toBe(200);
    await settle();
    expect(alerts()).toHaveLength(0);
  });

  it("emails once when the same account is signed in to from a browser it hasn't seen, and says what and when", async () => {
    await register(request.agent(app));
    const phone = request.agent(app);
    const res = await login(phone, "zoe", IPHONE);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    const mail = alerts()[0];
    expect(mail.subject).toBe("New sign-in to your CreativesSelect account");
    expect(mail.text).toContain("Safari on iPhone");
    expect(mail.text).toMatch(/GMT/);
    expect(mail.text).toMatch(/change your password right away/);
    expect(mail.text).toMatch(/two-step sign-in/);
    // it carries no link, no password and no address
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.text).not.toContain(PASSWORD);
    // the same phone again is then known
    expect((await login(phone, "zoe", IPHONE)).status).toBe(200);
    await settle();
    expect(alerts()).toHaveLength(1);
  });

  it("emails again for each further new browser", async () => {
    await register(request.agent(app));
    await login(request(app), "zoe", IPHONE);
    await login(request(app), "zoe", CHROME);
    await vi.waitFor(() => expect(alerts()).toHaveLength(2));
  });

  it("a wrong password sends nothing and records nothing", async () => {
    await register(request.agent(app));
    const res = await login(request(app), "zoe", IPHONE, "wrong-password");
    expect(res.status).toBe(401);
    expect(deviceCookie(res)).toBeUndefined();
    await settle();
    expect(alerts()).toHaveLength(0);
    expect((await M.User.findOne({ username: "zoe" })).knownDevices).toHaveLength(1);
  });

  it("people who signed up before this existed are recorded the first time, not emailed", async () => {
    await register(request.agent(app));
    await M.User.updateOne({ username: "zoe" }, { $set: { knownDevices: [] } }); // as every older account is
    await login(request(app), "zoe", IPHONE);
    await settle();
    expect(alerts()).toHaveLength(0);
    expect((await M.User.findOne({ username: "zoe" })).knownDevices).toHaveLength(1);
    // from then on a new browser is told about
    await login(request(app), "zoe", CHROME);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
  });

  it("turned off, it sends nothing, but still remembers the browser (so turning it on later doesn't warn about old ones)", async () => {
    const agent = request.agent(app);
    await register(agent);
    expect((await agent.put("/api/auth/sign-in-alerts").send({ enabled: false })).body).toEqual({ signInAlerts: false });
    const phone = request.agent(app);
    await login(phone, "zoe", IPHONE);
    await settle();
    expect(alerts()).toHaveLength(0);
    expect((await M.User.findOne({ username: "zoe" })).knownDevices).toHaveLength(2);
    await agent.put("/api/auth/sign-in-alerts").send({ enabled: true });
    await login(phone, "zoe", IPHONE);
    await settle();
    expect(alerts()).toHaveLength(0); // the phone was seen while it was off
    await login(request(app), "zoe", CHROME);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
  });

  it("is on by default, shows in the sessions list, and the switch needs a sign-in and a true or false", async () => {
    const agent = request.agent(app);
    await register(agent);
    expect((await agent.get("/api/auth/sessions")).body.signInAlerts).toBe(true);
    expect((await request(app).put("/api/auth/sign-in-alerts").send({ enabled: false })).status).toBe(401);
    for (const bad of [{}, { enabled: "false" }, { enabled: 0 }, { enabled: null }, { enabled: { $ne: true } }]) {
      expect((await agent.put("/api/auth/sign-in-alerts").send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await agent.get("/api/auth/sessions")).body.signInAlerts).toBe(true);
    await agent.put("/api/auth/sign-in-alerts").send({ enabled: false });
    expect((await agent.get("/api/auth/sessions")).body.signInAlerts).toBe(false);
  });

  it("the switch is the person's own", async () => {
    const zoe = request.agent(app);
    const sam = request.agent(app);
    await register(zoe);
    await register(sam, "sam");
    await zoe.put("/api/auth/sign-in-alerts").send({ enabled: false });
    expect((await sam.get("/api/auth/sessions")).body.signInAlerts).toBe(true);
  });

  it("sends at most five an hour, however many new browsers there are", async () => {
    await register(request.agent(app));
    for (let i = 0; i < 7; i++) await login(request(app), "zoe", i % 2 ? IPHONE : CHROME);
    await vi.waitFor(() => expect(alerts().length).toBeGreaterThan(0));
    await settle();
    expect(alerts()).toHaveLength(5);
  }, 60_000);

  it("remembers at most twenty browsers, forgetting the oldest", async () => {
    await register(request.agent(app));
    for (let i = 0; i < MAX_KNOWN_DEVICES + 3; i++) await login(request(app), "zoe", CHROME);
    expect((await M.User.findOne({ username: "zoe" })).knownDevices).toHaveLength(MAX_KNOWN_DEVICES);
  }, 90_000);

  it("keeps only a hash, made with the person's own id, so the same browser on two accounts can't be linked", async () => {
    const agent = request.agent(app);
    const first = await register(agent);
    const id = deviceCookie(first).match(/^device=([a-f0-9]{32})/)[1];
    // the same browser (same cookie) signs up a second person
    const second = await request(app).post("/api/auth/register").set("Cookie", `device=${id}`).send({ email: "sam@example.com", username: "sam", password: PASSWORD, displayName: "sam" });
    expect(deviceCookie(second)).toContain(`device=${id}`);
    const zoe = await M.User.findOne({ username: "zoe" }).lean();
    const sam = await M.User.findOne({ username: "sam" }).lean();
    expect(zoe.knownDevices[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(zoe.knownDevices[0].hash).not.toBe(sam.knownDevices[0].hash);
    expect(JSON.stringify([zoe.knownDevices, sam.knownDevices])).not.toContain(id);
  });

  it("treats a made-up or damaged device cookie as a new browser, and gives it a proper one", async () => {
    await register(request.agent(app));
    for (const junk of ["", "x", "../../etc", "a".repeat(5000), "ZZZZ".repeat(8), "<script>"]) {
      const res = await request(app).post("/api/auth/login").set("Cookie", `device=${junk}`).set("User-Agent", IPHONE).send({ email: "zoe@example.com", password: PASSWORD });
      expect(res.status, junk.slice(0, 20)).toBe(200);
      expect(deviceCookie(res)).toMatch(/^device=[a-f0-9]{32};/);
    }
  }, 60_000);

  it("a browser with someone else's device cookie is still new to this account", async () => {
    await register(request.agent(app));
    const sam = await register(request.agent(app), "sam");
    const samsId = deviceCookie(sam).match(/^device=([a-f0-9]{32})/)[1];
    await request(app).post("/api/auth/login").set("Cookie", `device=${samsId}`).set("User-Agent", IPHONE).send({ email: "zoe@example.com", password: PASSWORD });
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
  });

  it("signing in still works when the mail service is down", async () => {
    await register(request.agent(app));
    mailFails = true;
    const res = await login(request(app), "zoe", IPHONE);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("zoe");
    expect(res.headers["set-cookie"][0]).toMatch(/^token=/);
  });

  it("with two-step sign-in on, says nothing at the password step, and emails when the code finishes the sign-in", async () => {
    const zoe = request.agent(app);
    await register(zoe);
    const setup = await zoe.post("/api/auth/2fa/setup").send({ password: PASSWORD });
    const enable = await zoe.post("/api/auth/2fa/enable").send({ code: codeForStep(setup.body.secret, stepAt()) });
    expect(enable.status).toBe(200);
    outbox.length = 0;

    const phone = request.agent(app);
    const first = await login(phone, "zoe", IPHONE);
    expect(first.body.twoFactorRequired).toBe(true);
    expect(deviceCookie(first)).toBeUndefined(); // nothing is recorded until the second step
    await settle();
    expect(alerts()).toHaveLength(0);

    await M.User.updateOne({ username: "zoe" }, { "twoFactor.lastStep": 0 });
    const done = await phone.post("/api/auth/login/2fa").set("User-Agent", IPHONE).send({ challenge: first.body.challenge, code: codeForStep(setup.body.secret, stepAt()) });
    expect(done.status).toBe(200);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0].text).toContain("Safari on iPhone");
  });

  it("changing the password (which signs the person in again on that browser) sends nothing", async () => {
    const zoe = request.agent(app);
    await register(zoe);
    await zoe.put("/api/auth/password").send({ currentPassword: PASSWORD, newPassword: "a-new-password-9" });
    await settle();
    expect(alerts()).toHaveLength(0);
  });

  it("keeps all of it out of /me and the public profile", async () => {
    const zoe = request.agent(app);
    await register(zoe);
    await login(request(app), "zoe", IPHONE);
    const me = JSON.stringify((await zoe.get("/api/auth/me")).body);
    const profile = JSON.stringify((await request(app).get("/api/profiles/zoe")).body);
    for (const body of [me, profile]) expect(body).not.toMatch(/knownDevices|signInAlerts|firstSeen/);
  });

  it("goes with the account", async () => {
    const zoe = request.agent(app);
    await register(zoe);
    expect((await zoe.delete("/api/profiles/me").send({ password: PASSWORD })).status).toBe(204);
    expect(await M.User.countDocuments({ username: "zoe" })).toBe(0);
  });
});
