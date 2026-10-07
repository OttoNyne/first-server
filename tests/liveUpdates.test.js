import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

describe("live updates", () => {
  let app;
  let server;
  let port;
  let M;
  let service;
  const defaults = {};
  const streams = [];

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    service = await import("../services/liveUpdates.js");
    Object.assign(defaults, service.LIMITS);
    M = {
      User: (await import("../models/User.js")).User,
      Notification: (await import("../models/Notification.js")).Notification,
      Message: (await import("../models/Message.js")).Message,
      Friendship: (await import("../models/Friendship.js")).Friendship,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
      Session: (await import("../models/Session.js")).Session,
    };
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterEach(() => {
    for (const s of streams.splice(0)) s.close();
    service.closeAll();
    Object.assign(service.LIMITS, defaults);
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await clearTestDb();
    await disconnectTestDb();
  });

  const PASSWORD = "password-123";
  async function signup(name) {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: PASSWORD, displayName: name });
    expect(res.status).toBe(201);
    const cookie = res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
    return { agent, cookie, user: res.body.user };
  }
  async function befriend(a, b) {
    await M.Friendship.create({ requester: a.user.id, addressee: b.user.id, status: "accepted" });
  }

  /** Opens the stream the way a browser does and collects what comes down it. */
  function listen(cookie, { path = "/api/updates/stream" } = {}) {
    return new Promise((resolve, reject) => {
      const stream = { events: [], comments: [], raw: "", ended: false, status: 0, headers: {} };
      const req = http.get({ host: "127.0.0.1", port, path, headers: { cookie, accept: "text/event-stream" } }, (res) => {
        stream.status = res.statusCode;
        stream.headers = res.headers;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          stream.raw += chunk;
          for (const block of stream.raw.split("\n\n").slice(0, -1)) {
            const type = block.match(/^event: (.*)$/m)?.[1];
            if (type) stream.events.push({ type, data: JSON.parse(block.match(/^data: (.*)$/m)[1]) });
            for (const line of block.split("\n")) if (line.startsWith(":")) stream.comments.push(line);
          }
          stream.raw = stream.raw.slice(stream.raw.lastIndexOf("\n\n") + 2);
        });
        res.on("end", () => (stream.ended = true));
        res.on("close", () => (stream.ended = true));
        stream.close = () => req.destroy();
        resolve(stream);
      });
      req.on("error", (err) => (err.code === "ECONNRESET" ? null : reject(err)));
      streams.push({ close: () => req.destroy() });
    });
  }
  const until = (fn, timeout = 4000) => import("vitest").then(({ vi }) => vi.waitFor(fn, { timeout, interval: 20 }));
  const quiet = (ms = 250) => new Promise((r) => setTimeout(r, ms));

  it("is for signed-in people only", async () => {
    expect((await request(app).get("/api/updates/stream")).status).toBe(401);
    const forged = await request(app).get("/api/updates/stream").set("Cookie", "token=garbage");
    expect(forged.status).toBe(401);
  });

  it("opens an event stream that nothing along the way should hold back or keep", async () => {
    const zoe = await signup("zoe");
    const stream = await listen(zoe.cookie);
    await until(() => expect(stream.comments.length).toBeGreaterThan(0));
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(stream.headers["cache-control"]).toMatch(/no-store/);
    expect(stream.headers["cache-control"]).toMatch(/no-transform/);
    expect(stream.headers["x-accel-buffering"]).toBe("no");
    expect(stream.comments[0]).toContain("connected");
    expect(service.connectionCount()).toBe(1);
  });

  it("says so, with nothing in it, the moment a notification is made for the person", async () => {
    const zoe = await signup("zoe");
    const sam = await signup("sam");
    const forZoe = await listen(zoe.cookie);
    const forSam = await listen(sam.cookie);
    await until(() => expect(service.connectionCount()).toBe(2));
    await M.Notification.create({ recipient: zoe.user.id, type: "comment", payload: { actorId: sam.user.id, secret: "private words" } });
    await until(() => expect(forZoe.events).toHaveLength(1));
    expect(forZoe.events[0]).toEqual({ type: "notification", data: {} });
    await quiet();
    expect(forSam.events).toHaveLength(0); // someone else's notification is none of theirs
  });

  it("says so for notifications made in bulk too, once for each person", async () => {
    const zoe = await signup("zoe");
    const sam = await signup("sam");
    const forZoe = await listen(zoe.cookie);
    const forSam = await listen(sam.cookie);
    await until(() => expect(service.connectionCount()).toBe(2));
    await M.Notification.insertMany([
      { recipient: zoe.user.id, type: "comment", payload: {} },
      { recipient: sam.user.id, type: "comment", payload: {} },
    ]);
    await until(() => expect(forZoe.events).toHaveLength(1));
    await until(() => expect(forSam.events).toHaveLength(1));
  });

  it("tells both people when a message is sent, edited or deleted, each with who it was with and nothing of what it said", async () => {
    const zoe = await signup("zoe");
    const sam = await signup("sam");
    await befriend(zoe, sam);
    const forZoe = await listen(zoe.cookie);
    const forSam = await listen(sam.cookie);
    await until(() => expect(service.connectionCount()).toBe(2));

    const sent = await zoe.agent.post("/api/messages/with/sam").send({ body: "a private message" });
    expect(sent.status).toBe(201);
    await until(() => expect(forSam.events.filter((e) => e.type === "message")).toHaveLength(1));
    expect(forSam.events.find((e) => e.type === "message").data).toEqual({ with: "zoe" });
    expect(forZoe.events.find((e) => e.type === "message").data).toEqual({ with: "sam" }); // her other tabs and phone

    const before = forSam.events.filter((e) => e.type === "message").length;
    expect((await zoe.agent.patch(`/api/messages/${sent.body.message.id}`).send({ body: "a changed message" })).status).toBe(200);
    await until(() => expect(forSam.events.filter((e) => e.type === "message")).toHaveLength(before + 1));
    expect((await zoe.agent.delete(`/api/messages/${sent.body.message.id}`)).status).toBe(204);
    await until(() => expect(forSam.events.filter((e) => e.type === "message")).toHaveLength(before + 2));

    const everything = JSON.stringify([forZoe.events, forSam.events, forZoe.comments, forSam.comments]);
    expect(everything).not.toMatch(/private message|changed message/);
  });

  it("a message also makes the notification, so the recipient gets both hints", async () => {
    const zoe = await signup("zoe");
    const sam = await signup("sam");
    await befriend(zoe, sam);
    const forSam = await listen(sam.cookie);
    await until(() => expect(service.connectionCount()).toBe(1));
    await zoe.agent.post("/api/messages/with/sam").send({ body: "hello" });
    await until(() => expect(forSam.events.map((e) => e.type).sort()).toEqual(["message", "notification"]));
  });

  it("reaches every page the person has open", async () => {
    const zoe = await signup("zoe");
    const a = await listen(zoe.cookie);
    const b = await listen(zoe.cookie);
    await until(() => expect(service.connectionCount()).toBe(2));
    expect(service.publish(zoe.user.id, "notification")).toBe(2);
    await until(() => expect(a.events).toHaveLength(1));
    await until(() => expect(b.events).toHaveLength(1));
  });

  it("does nothing when no page is open, and never throws", async () => {
    const zoe = await signup("zoe");
    expect(service.publish(zoe.user.id, "notification")).toBe(0);
    expect(service.publish("not-an-id", "notification")).toBe(0);
    expect(service.publish(undefined, "notification")).toBe(0);
    await M.Notification.create({ recipient: zoe.user.id, type: "comment", payload: {} }); // and making one is unaffected
  });

  it("keeps the newest five pages for a person and lets go of the oldest", async () => {
    const zoe = await signup("zoe");
    const opened = [];
    for (let i = 0; i < 6; i++) {
      opened.push(await listen(zoe.cookie));
      await until(() => expect(opened[i].status).toBe(200));
    }
    await until(() => expect(opened[0].ended).toBe(true));
    expect(service.connectionCount()).toBe(5);
    expect(opened.slice(1).every((s) => !s.ended)).toBe(true);
  });

  it("is tidied up when the page goes away", async () => {
    const zoe = await signup("zoe");
    const stream = await listen(zoe.cookie);
    await until(() => expect(service.connectionCount()).toBe(1));
    stream.close();
    await until(() => expect(service.connectionCount()).toBe(0));
  });

  it("says it is busy, rather than taking more than the server can hold", async () => {
    const zoe = await signup("zoe");
    service.LIMITS.maxTotal = 0;
    const res = await request(app).get("/api/updates/stream").set("Cookie", zoe.cookie);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBeTruthy();
  });

  it("limits how often one person can open it, so a page stuck reconnecting can't hammer the server", async () => {
    const zoe = await signup("zoe");
    await M.RateLimitHit.insertMany(Array.from({ length: 90 }, () => ({ key: `updates-stream:${zoe.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 900_000) })));
    const res = await request(app).get("/api/updates/stream").set("Cookie", zoe.cookie);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeTruthy();
  });

  it("sends a keep-alive now and then so a quiet connection isn't dropped", async () => {
    service.LIMITS.heartbeatMs = 40;
    const zoe = await signup("zoe");
    const stream = await listen(zoe.cookie);
    await until(() => expect(stream.comments.filter((c) => c.includes("keep-alive")).length).toBeGreaterThanOrEqual(2));
  });

  it("ends each connection after a while, telling the page to reconnect", async () => {
    service.LIMITS.heartbeatMs = 40;
    service.LIMITS.maxAgeMs = 100;
    const zoe = await signup("zoe");
    const stream = await listen(zoe.cookie);
    await until(() => expect(stream.events.map((e) => e.type)).toContain("reconnect"));
    await until(() => expect(stream.ended).toBe(true));
    expect(service.connectionCount()).toBe(0);
  });

  describe("when the sign-in it was opened with stops counting", () => {
    beforeEach(() => {
      service.LIMITS.heartbeatMs = 40;
      service.LIMITS.recheckEveryBeats = 1;
    });

    it("signing that device out closes the stream, and leaves the other device's stream open", async () => {
      const zoe = await signup("zoe");
      const phone = request.agent(app);
      const login = await phone.post("/api/auth/login").send({ email: "zoe@example.com", password: PASSWORD });
      const phoneCookie = login.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
      const onLaptop = await listen(zoe.cookie);
      const onPhone = await listen(phoneCookie);
      await until(() => expect(service.connectionCount()).toBe(2));

      const phoneSession = (await zoe.agent.get("/api/auth/sessions")).body.sessions.find((s) => !s.current);
      expect((await zoe.agent.delete(`/api/auth/sessions/${phoneSession.id}`)).status).toBe(204);
      await until(() => expect(onPhone.ended).toBe(true));
      expect(onPhone.events.map((e) => e.type)).toContain("signed-out");
      expect(onLaptop.ended).toBe(false);
    });

    it("logging out closes it", async () => {
      const zoe = await signup("zoe");
      const stream = await listen(zoe.cookie);
      await until(() => expect(service.connectionCount()).toBe(1));
      await zoe.agent.post("/api/auth/logout");
      await until(() => expect(stream.ended).toBe(true));
    });

    it("changing the password closes every other stream", async () => {
      const zoe = await signup("zoe");
      const phone = request.agent(app);
      const login = await phone.post("/api/auth/login").send({ email: "zoe@example.com", password: PASSWORD });
      const onPhone = await listen(login.headers["set-cookie"].map((c) => c.split(";")[0]).join("; "));
      await until(() => expect(service.connectionCount()).toBe(1));
      expect((await zoe.agent.put("/api/auth/password").send({ currentPassword: PASSWORD, newPassword: "a-new-password-9" })).status).toBe(204);
      await until(() => expect(onPhone.ended).toBe(true));
    });

    it("suspending the account closes it", async () => {
      const zoe = await signup("zoe");
      const stream = await listen(zoe.cookie);
      await until(() => expect(service.connectionCount()).toBe(1));
      await M.User.updateOne({ username: "zoe" }, { suspendedAt: new Date() });
      await until(() => expect(stream.ended).toBe(true));
    });

    it("deleting the account closes it", async () => {
      const zoe = await signup("zoe");
      const stream = await listen(zoe.cookie);
      await until(() => expect(service.connectionCount()).toBe(1));
      expect((await zoe.agent.delete("/api/profiles/me").send({ password: PASSWORD })).status).toBe(204);
      await until(() => expect(stream.ended).toBe(true));
    });

    it("a stream whose sign-in is still good stays open through many checks", async () => {
      const zoe = await signup("zoe");
      const stream = await listen(zoe.cookie);
      await until(() => expect(stream.comments.filter((c) => c.includes("keep-alive")).length).toBeGreaterThanOrEqual(4));
      expect(stream.ended).toBe(false);
    });
  });
});
