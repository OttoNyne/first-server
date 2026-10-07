import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

describe("seen and typing, shared by two people or by neither", () => {
  let app;
  let server;
  let port;
  let M;
  let service;
  const streams = [];

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    service = await import("../services/liveUpdates.js");
    M = {
      User: (await import("../models/User.js")).User,
      Message: (await import("../models/Message.js")).Message,
      Friendship: (await import("../models/Friendship.js")).Friendship,
      Block: (await import("../models/Block.js")).Block,
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
    return { agent, user: res.body.user, cookie: res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ") };
  }
  async function friends(a, b) {
    await M.Friendship.create({ requester: a.user.id, addressee: b.user.id, status: "accepted" });
  }
  function listen(cookie) {
    return new Promise((resolve) => {
      const stream = { events: [] };
      const req = http.get({ host: "127.0.0.1", port, path: "/api/updates/stream", headers: { cookie, accept: "text/event-stream" } }, (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
          for (const block of raw.split("\n\n").slice(0, -1)) {
            const type = block.match(/^event: (.*)$/m)?.[1];
            if (type) stream.events.push({ type, data: JSON.parse(block.match(/^data: (.*)$/m)[1]) });
          }
          raw = raw.slice(raw.lastIndexOf("\n\n") + 2);
        });
        stream.close = () => req.destroy();
        resolve(stream);
      });
      req.on("error", () => {});
      streams.push({ close: () => req.destroy() });
    });
  }
  const until = (fn, timeout = 4000) => import("vitest").then(({ vi }) => vi.waitFor(fn, { timeout, interval: 20 }));
  const quiet = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  const setStatus = (me, on) => me.agent.patch("/api/profiles/me").send({ chatStatus: on });
  const thread = async (me, other) => (await me.agent.get(`/api/messages/with/${other.user.username}`)).body.messages;
  const typing = (me, other) => me.agent.post(`/api/messages/with/${other.user.username}/typing`).send({});

  describe("the setting", () => {
    it("is on to begin with, belongs to the owner, and can be switched off and on", async () => {
      const zoe = await signup("zoe");
      expect((await zoe.agent.get("/api/auth/me")).body.user.chatStatus).toBe(true);
      const off = await setStatus(zoe, false);
      expect(off.status).toBe(200);
      expect(off.body.user.chatStatus).toBe(false);
      expect((await zoe.agent.get("/api/auth/me")).body.user.chatStatus).toBe(false);
      expect((await setStatus(zoe, true)).body.user.chatStatus).toBe(true);
    });

    it("takes only true or false, and changes nothing else when it is refused", async () => {
      const zoe = await signup("zoe");
      for (const bad of ["false", 0, null, {}, [], "off"]) {
        const res = await zoe.agent.patch("/api/profiles/me").send({ chatStatus: bad, bio: "Should not stick" });
        expect(res.status, JSON.stringify(bad)).toBe(400);
      }
      expect((await M.User.findOne({ username: "zoe" })).bio).not.toBe("Should not stick");
      expect((await M.User.findOne({ username: "zoe" })).chatStatus).toBe(true);
    });

    it("is not shown to anyone else on the profile", async () => {
      const zoe = await signup("zoe");
      await setStatus(zoe, false);
      expect(JSON.stringify((await request(app).get("/api/profiles/zoe")).body)).not.toMatch(/chatStatus/);
    });
  });

  describe("seen", () => {
    async function pair() {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      await friends(zoe, sam);
      return { zoe, sam };
    }

    it("shows the sender when their message was read, once the other person opens the chat", async () => {
      const { zoe, sam } = await pair();
      await zoe.agent.post("/api/messages/with/sam").send({ body: "Hello" });
      expect((await thread(zoe, sam))[0].readAt).toBeNull();
      await thread(sam, zoe); // sam opens the chat
      const seen = (await thread(zoe, sam))[0];
      expect(Date.parse(seen.readAt)).toBeGreaterThan(Date.now() - 60_000);
    });

    it("never sends the read time to the person who received the message", async () => {
      const { zoe, sam } = await pair();
      await zoe.agent.post("/api/messages/with/sam").send({ body: "Hello" });
      const asSam = await thread(sam, zoe);
      expect(asSam[0].readAt).toBeNull();
      expect((await thread(sam, zoe))[0].readAt).toBeNull();
    });

    it("tells the sender's open chat at once, so it shows Seen without waiting", async () => {
      const { zoe, sam } = await pair();
      await zoe.agent.post("/api/messages/with/sam").send({ body: "Hello" });
      const forZoe = await listen(zoe.cookie);
      await until(() => expect(service.connectionCount()).toBe(1));
      await thread(sam, zoe);
      await until(() => expect(forZoe.events.some((e) => e.type === "message" && e.data.with === "sam")).toBe(true));
    });

    it("is not shown when the sender has switched it off", async () => {
      const { zoe, sam } = await pair();
      await setStatus(zoe, false);
      await zoe.agent.post("/api/messages/with/sam").send({ body: "Hello" });
      await thread(sam, zoe);
      expect((await thread(zoe, sam))[0].readAt).toBeNull();
    });

    it("is not shown when the reader has switched it off, and the sender can't tell which of them it was", async () => {
      const { zoe, sam } = await pair();
      await setStatus(sam, false);
      await zoe.agent.post("/api/messages/with/sam").send({ body: "Hello" });
      await thread(sam, zoe);
      expect((await thread(zoe, sam))[0].readAt).toBeNull();
      // and the message still counts as read: the unread badge is unaffected by the setting
      expect((await sam.agent.get("/api/messages/unread-count")).body.unread).toBe(0);
    });

    it("comes back when both switch it on again, for messages already read", async () => {
      const { zoe, sam } = await pair();
      await setStatus(zoe, false);
      await zoe.agent.post("/api/messages/with/sam").send({ body: "Hello" });
      await thread(sam, zoe);
      expect((await thread(zoe, sam))[0].readAt).toBeNull();
      await setStatus(zoe, true);
      expect(Date.parse((await thread(zoe, sam))[0].readAt)).toBeGreaterThan(0);
    });

    it("doesn't send the hint to the sender when they may not see it", async () => {
      const { zoe, sam } = await pair();
      await setStatus(sam, false);
      await zoe.agent.post("/api/messages/with/sam").send({ body: "Hello" });
      const forZoe = await listen(zoe.cookie);
      await until(() => expect(service.connectionCount()).toBe(1));
      await thread(sam, zoe);
      await quiet();
      expect(forZoe.events).toHaveLength(0);
    });

    it("never puts a read time in the conversation list or in a new or edited message", async () => {
      const { zoe, sam } = await pair();
      const sent = await zoe.agent.post("/api/messages/with/sam").send({ body: "Hello" });
      expect(sent.body.message.readAt).toBeNull();
      await thread(sam, zoe);
      const list = (await zoe.agent.get("/api/messages/conversations")).body.conversations;
      expect(list[0].lastMessage.readAt).toBeNull();
      const edited = await zoe.agent.patch(`/api/messages/${sent.body.message.id}`).send({ body: "Hello again" });
      expect(edited.body.message.readAt).toBeNull();
    });
  });

  describe("typing", () => {
    it("tells the other person's open pages, with who is typing and nothing else", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      await friends(zoe, sam);
      const forSam = await listen(sam.cookie);
      const forZoe = await listen(zoe.cookie);
      await until(() => expect(service.connectionCount()).toBe(2));
      expect((await typing(zoe, sam)).status).toBe(204);
      await until(() => expect(forSam.events).toHaveLength(1));
      expect(forSam.events[0]).toEqual({ type: "typing", data: { with: "zoe" } });
      await quiet();
      expect(forZoe.events).toHaveLength(0); // not echoed back to the person typing
    });

    it("is for friends only, and says the same as anywhere else about someone who isn't", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      const stranger = await typing(zoe, sam);
      expect(stranger.status).toBe(403);
      expect((await typing(zoe, { user: { username: "nobody" } })).status).toBe(404);
      expect((await request(app).post("/api/messages/with/sam/typing").send({})).status).toBe(401);
    });

    it("is stopped by a block in either direction", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      await friends(zoe, sam);
      await M.Block.create({ blocker: sam.user.id, blocked: zoe.user.id });
      const forSam = await listen(sam.cookie);
      await until(() => expect(service.connectionCount()).toBe(1));
      const res = await typing(zoe, sam);
      expect(res.status).toBeGreaterThanOrEqual(400);
      await quiet();
      expect(forSam.events).toHaveLength(0);
    });

    it("sends nothing when either person has switched it off, and answers exactly the same", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      const kim = await signup("kim");
      await friends(zoe, sam);
      await friends(zoe, kim);
      await setStatus(sam, false);
      const forSam = await listen(sam.cookie);
      const forKim = await listen(kim.cookie);
      await until(() => expect(service.connectionCount()).toBe(2));
      const toSam = await typing(zoe, sam);
      await new Promise((r) => setTimeout(r, 1100)); // past the one-a-second limit
      const toKim = await typing(zoe, kim);
      expect(toSam.status).toBe(204);
      expect(toKim.status).toBe(204);
      expect(toSam.headers["content-length"] ?? "0").toBe(toKim.headers["content-length"] ?? "0");
      await until(() => expect(forKim.events).toHaveLength(1));
      await quiet();
      expect(forSam.events).toHaveLength(0);

      // and the typist's own setting counts too
      await setStatus(zoe, false);
      await new Promise((r) => setTimeout(r, 1100));
      await typing(zoe, kim);
      await quiet();
      expect(forKim.events).toHaveLength(1);
    });

    it("quietly ignores pings that come faster than one a second, so it can't be used to flood someone", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      await friends(zoe, sam);
      const forSam = await listen(sam.cookie);
      await until(() => expect(service.connectionCount()).toBe(1));
      const answers = await Promise.all([typing(zoe, sam), typing(zoe, sam), typing(zoe, sam), typing(zoe, sam)]);
      expect(answers.map((a) => a.status)).toEqual([204, 204, 204, 204]);
      await quiet();
      expect(forSam.events).toHaveLength(1);
    });

    it("keeps nothing: no record is made of it", async () => {
      const zoe = await signup("zoe");
      const sam = await signup("sam");
      await friends(zoe, sam);
      const before = await M.Message.countDocuments();
      await typing(zoe, sam);
      expect(await M.Message.countDocuments()).toBe(before);
    });
  });
});
