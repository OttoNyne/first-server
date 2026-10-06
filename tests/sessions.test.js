import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { deviceLabel } from "../utils/deviceLabel.js";

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";

describe("deviceLabel", () => {
  it.each([
    [CHROME_WIN, "Chrome on Windows"],
    [SAFARI_IPHONE, "Safari on iPhone"],
    [FIREFOX_LINUX, "Firefox on Linux"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari on Mac"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1", "Chrome on iPhone"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", "Samsung Internet on Android"],
  ])("describes %s as %s", (ua, label) => expect(deviceLabel(ua)).toBe(label));

  it("never keeps anything the browser said beyond the fixed words", () => {
    expect(deviceLabel("<script>alert(1)</script>")).toBe("A browser");
    expect(deviceLabel("curl/8.0")).toBe("A browser");
    expect(deviceLabel("")).toBe("A browser");
    expect(deviceLabel(undefined)).toBe("A browser");
    expect(deviceLabel(["Chrome/1"])).toBe("A browser");
    expect(deviceLabel("Windows <img src=x onerror=alert(1)>")).toBe("A browser on Windows");
    expect(deviceLabel("x".repeat(100000) + " Chrome/1")).toBe("A browser"); // only the start is looked at
  });
});

describe("where you're signed in", () => {
  let app;
  let M;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      Session: (await import("../models/Session.js")).Session,
      User: (await import("../models/User.js")).User,
      PasswordReset: (await import("../models/PasswordReset.js")).PasswordReset,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const PASSWORD = "password-123";
  /** An agent that always says which browser it is. */
  function device(ua) {
    const agent = request.agent(app);
    const send = (method) => (url) => agent[method](url).set("User-Agent", ua);
    return { agent, get: send("get"), post: send("post"), put: send("put"), delete: send("delete"), patch: send("patch") };
  }
  async function signup(name, ua = CHROME_WIN) {
    const d = device(ua);
    const res = await d.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: PASSWORD, displayName: name });
    expect(res.status).toBe(201);
    return { ...d, user: res.body.user, cookie: res.headers["set-cookie"][0].split(";")[0] };
  }
  async function loginOn(name, ua) {
    const d = device(ua);
    const res = await d.post("/api/auth/login").send({ email: `${name}@example.com`, password: PASSWORD });
    expect(res.status).toBe(200);
    return d;
  }
  const list = async (d) => (await d.get("/api/auth/sessions")).body.sessions;

  it("requires being signed in", async () => {
    expect((await request(app).get("/api/auth/sessions")).status).toBe(401);
    expect((await request(app).post("/api/auth/sessions/end-others")).status).toBe(401);
    expect((await request(app).delete("/api/auth/sessions/000000000000000000000000")).status).toBe(401);
  });

  it("gives every sign-in a row and shows it in the list, labelled with the kind of browser and marked as this one", async () => {
    const zoe = await signup("zoe");
    const sessions = await list(zoe);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ device: "Chrome on Windows", current: true });
    expect(Date.parse(sessions[0].createdAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(sessions[0].lastSeenAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(Object.keys(sessions[0]).sort()).toEqual(["createdAt", "current", "device", "id", "lastSeenAt"]);
  });

  it("lists this device first, then the others most recently used first, and only the person's own", async () => {
    const zoe = await signup("zoe");
    const phone = await loginOn("zoe", SAFARI_IPHONE);
    const laptop = await loginOn("zoe", FIREFOX_LINUX);
    const sam = await signup("sam", FIREFOX_LINUX);
    const seen = await list(phone);
    expect(seen.map((s) => s.device)).toEqual(["Safari on iPhone", "Firefox on Linux", "Chrome on Windows"]);
    expect(seen.map((s) => s.current)).toEqual([true, false, false]);
    expect((await list(laptop))[0]).toMatchObject({ device: "Firefox on Linux", current: true });
    // Sam sees only Sam's
    const samsList = await list(sam);
    expect(samsList).toHaveLength(1);
    expect(seen.some((s) => s.id === samsList[0].id)).toBe(false);
    await list(zoe);
  });

  it("stores only the label, never the browser's own text or an address", async () => {
    await signup("zoe");
    const row = (await M.Session.find().lean())[0];
    expect(Object.keys(row).sort()).toEqual(["__v", "_id", "createdAt", "device", "expireAt", "lastSeenAt", "user"].sort());
    expect(JSON.stringify(row)).not.toMatch(/Mozilla|127\.0\.0\.1|::1/);
  });

  it("ends one other sign-in: it stops working at once, and this one carries on", async () => {
    const zoe = await signup("zoe");
    const phone = await loginOn("zoe", SAFARI_IPHONE);
    expect((await phone.get("/api/auth/me")).status).toBe(200);
    const phoneRow = (await list(zoe)).find((s) => s.device === "Safari on iPhone");

    const res = await zoe.delete(`/api/auth/sessions/${phoneRow.id}`);
    expect(res.status).toBe(204);
    expect((await phone.get("/api/auth/me")).status).toBe(401);
    expect((await phone.get("/api/auth/sessions")).status).toBe(401);
    expect((await zoe.get("/api/auth/me")).status).toBe(200);
    expect(await list(zoe)).toHaveLength(1);
  });

  it("won't end the device being used (that's what Log out is for), and says so", async () => {
    const zoe = await signup("zoe");
    const [mine] = await list(zoe);
    const res = await zoe.delete(`/api/auth/sessions/${mine.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Log out/);
    expect((await zoe.get("/api/auth/me")).status).toBe(200);
  });

  it("answers someone else's sign-in, an ended one and nonsense the same way, and leaves other people's alone", async () => {
    const zoe = await signup("zoe");
    const sam = await signup("sam");
    const [samsRow] = await list(sam);
    for (const id of [samsRow.id, "000000000000000000000000", "not-an-id", "{}", "%00"]) {
      const res = await zoe.delete(`/api/auth/sessions/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.body.error).toBe("That sign-in wasn't found");
    }
    expect(await M.Session.countDocuments({ user: sam.user.id })).toBe(1);
    expect((await sam.get("/api/auth/me")).status).toBe(200);
  });

  it("ends every other sign-in at once and keeps this one; doing it again ends nothing", async () => {
    const zoe = await signup("zoe");
    const phone = await loginOn("zoe", SAFARI_IPHONE);
    const laptop = await loginOn("zoe", FIREFOX_LINUX);
    const sam = await signup("sam");

    const res = await laptop.post("/api/auth/sessions/end-others");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ended: 2 });
    expect((await zoe.get("/api/auth/me")).status).toBe(401);
    expect((await phone.get("/api/auth/me")).status).toBe(401);
    expect((await laptop.get("/api/auth/me")).status).toBe(200);
    expect(await list(laptop)).toHaveLength(1);
    expect((await laptop.post("/api/auth/sessions/end-others")).body).toEqual({ ended: 0 });
    // other people are untouched
    expect((await sam.get("/api/auth/me")).status).toBe(200);
  });

  it("is limited, so a script can't keep ending sign-ins", async () => {
    const zoe = await signup("zoe");
    await M.RateLimitHit.insertMany(Array.from({ length: 30 }, () => ({ key: `end-sessions:${zoe.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 3_600_000) })));
    const res = await zoe.post("/api/auth/sessions/end-others");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeTruthy();
    expect((await zoe.delete("/api/auth/sessions/000000000000000000000000")).status).toBe(429);
    expect((await zoe.get("/api/auth/sessions")).status).toBe(200); // looking is never limited
  });

  it("logging out ends the sign-in itself, so the cookie can't be used again even if it was kept", async () => {
    const zoe = await signup("zoe");
    const phone = await loginOn("zoe", SAFARI_IPHONE);
    const kept = zoe.cookie;
    expect((await request(app).get("/api/auth/me").set("Cookie", kept)).status).toBe(200);
    expect((await zoe.post("/api/auth/logout")).status).toBe(204);
    expect((await request(app).get("/api/auth/me").set("Cookie", kept)).status).toBe(401);
    expect(await M.Session.countDocuments({ user: zoe.user.id })).toBe(1);
    expect((await phone.get("/api/auth/me")).status).toBe(200);
  });

  it("logging out never fails, whatever the cookie is", async () => {
    expect((await request(app).post("/api/auth/logout")).status).toBe(204);
    expect((await request(app).post("/api/auth/logout").set("Cookie", "token=garbage")).status).toBe(204);
    const forged = jwt.sign({ id: "000000000000000000000000", sid: "000000000000000000000000" }, "some-other-secret");
    expect((await request(app).post("/api/auth/logout").set("Cookie", `token=${forged}`)).status).toBe(204);
  });

  it("a cookie can't be pointed at someone else's sign-in", async () => {
    const zoe = await signup("zoe");
    const sam = await signup("sam");
    const [samsRow] = await list(sam);
    // Even a token Zoe could sign herself (she can't: it needs the secret) would have to name her own row.
    const crossed = jwt.sign({ id: zoe.user.id, username: "zoe", pv: 0, sid: samsRow.id }, process.env.JWT_SECRET);
    expect((await request(app).get("/api/auth/me").set("Cookie", `token=${crossed}`)).status).toBe(401);
    const bad = jwt.sign({ id: zoe.user.id, username: "zoe", pv: 0, sid: "nonsense" }, process.env.JWT_SECRET);
    expect((await request(app).get("/api/auth/me").set("Cookie", `token=${bad}`)).status).toBe(401);
  });

  it("changing the password ends every other sign-in and keeps (and lists) the one that changed it", async () => {
    const zoe = await signup("zoe");
    const phone = await loginOn("zoe", SAFARI_IPHONE);
    expect((await zoe.put("/api/auth/password").send({ currentPassword: PASSWORD, newPassword: "a-brand-new-pass-9" })).status).toBe(204);
    expect((await phone.get("/api/auth/me")).status).toBe(401);
    expect((await zoe.get("/api/auth/me")).status).toBe(200);
    const sessions = await list(zoe);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].current).toBe(true);
    expect(await M.Session.countDocuments({ user: zoe.user.id })).toBe(1);
  });

  it("resetting a forgotten password ends every sign-in", async () => {
    const zoe = await signup("zoe");
    await loginOn("zoe", SAFARI_IPHONE);
    const token = "t".repeat(40);
    await M.PasswordReset.create({ user: zoe.user.id, tokenHash: createHash("sha256").update(token).digest("hex"), expireAt: new Date(Date.now() + 600_000) });
    expect((await request(app).post("/api/auth/reset-password").send({ token, newPassword: "reset-pass-word-7" })).status).toBe(204);
    expect(await M.Session.countDocuments({ user: zoe.user.id })).toBe(0);
    expect((await zoe.get("/api/auth/me")).status).toBe(401);
  });

  it("changing the username keeps the sign-in: still one row, still this device", async () => {
    const zoe = await signup("zoe");
    const res = await zoe.put("/api/profiles/me/username").send({ username: "zoe2" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await zoe.get("/api/auth/me")).status).toBe(200);
    const sessions = await list(zoe);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].current).toBe(true);
    expect(await M.Session.countDocuments({ user: zoe.user.id })).toBe(1);
  });

  it("deleting the account removes its sign-ins", async () => {
    const zoe = await signup("zoe");
    const phone = await loginOn("zoe", SAFARI_IPHONE);
    const sam = await signup("sam");
    expect((await zoe.delete("/api/profiles/me").send({ password: PASSWORD })).status).toBe(204);
    expect(await M.Session.countDocuments({ user: zoe.user.id })).toBe(0);
    expect((await phone.get("/api/auth/me")).status).toBe(401);
    expect(await M.Session.countDocuments({ user: sam.user.id })).toBe(1);
  });

  it("keeps at most twenty per person: the least recently used go first", async () => {
    const zoe = await signup("zoe");
    const first = (await list(zoe))[0];
    for (let i = 0; i < 20; i++) await loginOn("zoe", FIREFOX_LINUX);
    expect(await M.Session.countDocuments({ user: zoe.user.id })).toBe(20);
    expect(await M.Session.exists({ _id: first.id })).toBeNull();
  }, 60_000);

  it("each row expires by itself after seven days, like the cookie, and the database clears it", async () => {
    await signup("zoe");
    const row = await M.Session.findOne().lean();
    const days = (row.expireAt.getTime() - row.createdAt.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 3);
    const ttl = (await M.Session.collection.indexes()).find((i) => i.key.expireAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(0);
  });

  it("notes when a device was last used, but only now and then, so ordinary requests write nothing", async () => {
    const zoe = await signup("zoe");
    const row = await M.Session.findOne();
    const recent = new Date(Date.now() - 60_000);
    await M.Session.updateOne({ _id: row._id }, { lastSeenAt: recent });
    await zoe.get("/api/auth/me");
    expect((await M.Session.findById(row._id)).lastSeenAt.getTime()).toBe(recent.getTime());

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await M.Session.updateOne({ _id: row._id }, { lastSeenAt: old });
    await zoe.get("/api/auth/me");
    expect((await M.Session.findById(row._id)).lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  describe("a sign-in from before devices were listed", () => {
    const legacyCookie = (user, iatSecondsAgo = 5) => `token=${jwt.sign({ id: user.id, username: user.username, pv: 0, iat: Math.floor(Date.now() / 1000) - iatSecondsAgo }, process.env.JWT_SECRET, { expiresIn: "7d" })}`;

    it("still works, and is given a row (and a new cookie) the first time the list is opened", async () => {
      const zoe = await signup("zoe");
      await M.Session.deleteMany({});
      const old = legacyCookie(zoe.user);
      expect((await request(app).get("/api/auth/me").set("Cookie", old)).status).toBe(200);
      expect(await M.Session.countDocuments()).toBe(0);

      const res = await request(app).get("/api/auth/sessions").set("Cookie", old).set("User-Agent", SAFARI_IPHONE);
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([expect.objectContaining({ device: "Safari on iPhone", current: true })]);
      const fresh = res.headers["set-cookie"][0].split(";")[0];
      expect(jwt.decode(fresh.replace("token=", "")).sid).toBe(res.body.sessions[0].id);
      expect((await request(app).get("/api/auth/me").set("Cookie", fresh)).status).toBe(200);
    });

    it("is ended by \"sign out everywhere else\", though it has no row to end", async () => {
      const zoe = await signup("zoe");
      const old = legacyCookie(zoe.user, 30);
      expect((await request(app).get("/api/auth/me").set("Cookie", old)).status).toBe(200);
      expect((await zoe.post("/api/auth/sessions/end-others")).status).toBe(200);
      expect((await request(app).get("/api/auth/me").set("Cookie", old)).status).toBe(401);
      expect((await zoe.get("/api/auth/me")).status).toBe(200);
    });

    it("can itself use \"sign out everywhere else\" and stays signed in", async () => {
      const zoe = await signup("zoe");
      const phone = await loginOn("zoe", SAFARI_IPHONE);
      await M.Session.deleteMany({ user: zoe.user.id });
      const old = legacyCookie(zoe.user, 60);
      const res = await request(app).post("/api/auth/sessions/end-others").set("Cookie", old);
      expect(res.status).toBe(200);
      const fresh = res.headers["set-cookie"][0].split(";")[0];
      expect((await request(app).get("/api/auth/me").set("Cookie", fresh)).status).toBe(200);
      expect((await phone.get("/api/auth/me")).status).toBe(401);
    });
  });

  it("doesn't show any of this in the public profile or in /me", async () => {
    const zoe = await signup("zoe");
    await zoe.post("/api/auth/sessions/end-others");
    const me = (await zoe.get("/api/auth/me")).body.user;
    const profile = (await request(app).get("/api/profiles/zoe")).body.user;
    for (const body of [me, profile]) expect(JSON.stringify(body)).not.toMatch(/sessionsRevokedAt|Session|device/i);
  });
});
