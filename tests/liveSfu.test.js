import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

// The LiveKit management client is replaced by one that records what it was asked to do.
const lk = vi.hoisted(() => ({ created: [], deleted: [], removed: [], urls: [], failCreate: false }));
vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRoomServiceClient {
    constructor(url) {
      lk.urls.push(url);
    }
    async createRoom(opts) {
      if (lk.failCreate) throw new Error("media server down");
      lk.created.push(opts);
    }
    async deleteRoom(name) {
      lk.deleted.push(name);
    }
    async removeParticipant(room, identity) {
      lk.removed.push([room, identity]);
    }
  }
  return { ...actual, RoomServiceClient: FakeRoomServiceClient };
});

const KEYS = { LIVEKIT_URL: "wss://demo-project.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "secret-secret-secret-secret-1234567" };

async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("voice lives through a media server (SFU)", () => {
  let app;
  let LiveListener, LiveSession;
  let services;

  const withKeys = (extra = {}) => Object.assign(process.env, KEYS, extra);
  const withoutKeys = () => {
    for (const k of [...Object.keys(KEYS), "LIVE_MAX_LISTENERS"]) delete process.env[k];
  };

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ LiveListener, LiveSession } = await import("../models/Live.js"));
    services = await import("../services/livekit.js");
  });
  beforeEach(async () => {
    await clearTestDb();
    lk.created.length = lk.deleted.length = lk.removed.length = lk.urls.length = 0;
    lk.failCreate = false;
    withoutKeys();
  });
  afterEach(withoutKeys);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const goLive = (who, title = "Big room") => who.agent.post("/api/live").send({ title });
  const join = (who, id) => who.agent.post(`/api/live/${id}/join`);
  const token = (who, id) => who.agent.post(`/api/live/${id}/token`);

  describe("which mode a live gets", () => {
    it("is browser-to-browser with 8 listeners when no media server is configured", async () => {
      const alice = await signup(app, "alice");
      const res = await goLive(alice);
      expect(res.body.live).toMatchObject({ mode: "mesh", maxListeners: 8, heartbeatMs: 10_000, commentPollMs: 3_000 });
      expect(lk.created).toHaveLength(0);
      expect((await alice.agent.get("/api/live")).body.config).toEqual({ mode: "mesh", maxListeners: 8 });
    });

    it("uses the media server, with room for 50 listeners, once it is configured", async () => {
      withKeys();
      const alice = await signup(app, "alice");
      const res = await goLive(alice);
      expect(res.status).toBe(201);
      expect(res.body.live).toMatchObject({ mode: "sfu", maxListeners: 50, heartbeatMs: 20_000, commentPollMs: 6_000 });
      expect((await alice.agent.get("/api/live")).body.config).toEqual({ mode: "sfu", maxListeners: 50 });
    });

    it("creates the media room under the live's id with room for everyone plus the host, over https", async () => {
      withKeys();
      const alice = await signup(app, "alice");
      const id = (await goLive(alice)).body.live.id;
      expect(lk.created).toEqual([{ name: id, maxParticipants: 51, emptyTimeout: 120 }]);
      expect(lk.urls[0]).toBe("https://demo-project.livekit.cloud");
    });

    it("keeps the capacity within 50 to 100, however it is set", () => {
      for (const [value, expected] of [[undefined, 50], ["20", 50], ["50", 50], ["75", 75], ["100", 100], ["500", 100], ["abc", 50], ["", 50]]) {
        if (value === undefined) delete process.env.LIVE_MAX_LISTENERS;
        else process.env.LIVE_MAX_LISTENERS = value;
        expect(services.sfuMaxListeners(), String(value)).toBe(expected);
      }
    });

    it("applies LIVE_MAX_LISTENERS to new lives", async () => {
      withKeys({ LIVE_MAX_LISTENERS: "80" });
      const alice = await signup(app, "alice");
      expect((await goLive(alice)).body.live.maxListeners).toBe(80);
    });

    it("leaves a live in progress as it was when the settings change afterwards", async () => {
      const alice = await signup(app, "alice");
      const id = (await goLive(alice)).body.live.id; // started in browser-to-browser mode
      withKeys();
      expect((await alice.agent.get(`/api/live/${id}`)).body.live).toMatchObject({ mode: "mesh", maxListeners: 8 });
      expect((await token(alice, id)).status).toBe(400);
    });

    it("says so, and starts nothing, if the media server can't create the room", async () => {
      withKeys();
      lk.failCreate = true;
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await befriend(alice, bob);
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await goLive(alice);
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/temporarily unavailable/);
      expect(await LiveSession.countDocuments()).toBe(0);
      const { Notification } = await import("../models/Notification.js");
      expect(await Notification.countDocuments({ type: "live_started" })).toBe(0); // friends aren't told about a live that didn't start
      expect(spy.mock.calls.flat().join(" ")).toMatch(/LIVE AUDIO SERVICE UNAVAILABLE/);
      spy.mockRestore();
    });
  });

  describe("access tokens", () => {
    async function room() {
      withKeys();
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const id = (await goLive(alice)).body.live.id;
      await join(bob, id);
      return { alice, bob, id };
    }
    const decode = (t) => jwt.verify(t, KEYS.LIVEKIT_API_SECRET);

    it("gives the host a pass that can publish a microphone and listen", async () => {
      const { alice, id } = await room();
      const res = await token(alice, id);
      expect(res.status).toBe(200);
      expect(res.body.url).toBe(KEYS.LIVEKIT_URL);
      const claims = decode(res.body.token);
      expect(claims.iss).toBe(KEYS.LIVEKIT_API_KEY);
      expect(claims.sub).toBe(alice.user.id);
      expect(claims.name).toBe("alice");
      expect(claims.video).toMatchObject({ room: id, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false });
      expect(claims.video.canPublishSources).toEqual(["microphone"]);
    });

    it("gives a listener a pass that can only listen", async () => {
      const { bob, id } = await room();
      const claims = decode((await token(bob, id)).body.token);
      expect(claims.sub).toBe(bob.user.id);
      expect(claims.video).toMatchObject({ room: id, roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: false });
      expect(claims.video.canPublishSources).toBeUndefined();
    });

    it("expires in about an hour", async () => {
      const { bob, id } = await room();
      const claims = decode((await token(bob, id)).body.token);
      expect(claims.exp - claims.nbf).toBeGreaterThan(3500);
      expect(claims.exp - claims.nbf).toBeLessThanOrEqual(3700);
    });

    it("is only for people in the room, and only while it is live", async () => {
      const { alice, id } = await room();
      const outsider = await signup(app, "outsider");
      expect((await token(outsider, id)).status).toBe(403);
      expect((await request(app).post(`/api/live/${id}/token`)).status).toBe(401);
      expect((await token(alice, "not-an-id")).status).toBe(404);
      await alice.agent.post(`/api/live/${id}/end`);
      expect((await token(alice, id)).status).toBe(409);
    });

    it("is never signed with anything but the project's secret", async () => {
      const { bob, id } = await room();
      const t = (await token(bob, id)).body.token;
      expect(() => jwt.verify(t, "some-other-secret-some-other-secret-1234")).toThrow();
    });
  });

  describe("capacity and cleanup", () => {
    async function bigRoom() {
      withKeys();
      const alice = await signup(app, "alice");
      const id = (await goLive(alice)).body.live.id;
      return { alice, id };
    }
    const fill = async (id, n) => {
      const { User } = await import("../models/User.js");
      const now = Date.now();
      const users = await User.insertMany(
        Array.from({ length: n }, (_, i) => ({ email: `fan${i}@example.com`, username: `fan${i}`, displayName: `Fan ${i}`, passwordHash: "x" }))
      );
      await LiveListener.insertMany(users.map((u) => ({ session: id, user: u._id, lastSeen: new Date(now), expireAt: new Date(now + 600_000) })));
    };

    it("lets 50 people in and then says the room is full", async () => {
      const { id } = await bigRoom();
      await fill(id, 50);
      const late = await signup(app, "late");
      const res = await join(late, id);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/full \(50 listeners\)/);
    });

    it("has room for the 9th listener that browser-to-browser lives turn away", async () => {
      const { id } = await bigRoom();
      await fill(id, 8);
      const ninth = await signup(app, "ninth");
      expect((await join(ninth, id)).status).toBe(200);
    });

    it("counts a listener who reported in 45 seconds ago in a big room (30 in a small one)", async () => {
      const { alice, id } = await bigRoom();
      await fill(id, 3);
      await LiveListener.updateMany({ session: id }, { $set: { lastSeen: new Date(Date.now() - 45_000) } });
      expect((await alice.agent.get(`/api/live/${id}`)).body.live.listenerCount).toBe(3);
      await LiveListener.updateMany({ session: id }, { $set: { lastSeen: new Date(Date.now() - 70_000) } });
      expect((await alice.agent.get(`/api/live/${id}`)).body.live.listenerCount).toBe(0);
    });

    it("doesn't take WebRTC handshake messages: the media server does that", async () => {
      const { alice, id } = await bigRoom();
      const bob = await signup(app, "bob");
      await join(bob, id);
      const send = await bob.agent.post(`/api/live/${id}/signals`).send({ to: alice.user.id, kind: "offer", data: { sdp: "x" } });
      expect(send.status).toBe(400);
      expect((await alice.agent.get(`/api/live/${id}/signals`)).status).toBe(400);
    });

    it("closes the media room when the host ends the live", async () => {
      const { alice, id } = await bigRoom();
      await alice.agent.post(`/api/live/${id}/end`);
      expect(lk.deleted).toEqual([id]);
    });

    it("closes the media room of a live whose host went quiet", async () => {
      const { alice, id } = await bigRoom();
      await LiveSession.updateOne({ _id: id }, { $set: { lastHeartbeat: new Date(Date.now() - 60_000) } });
      await alice.agent.get("/api/live");
      expect(lk.deleted).toEqual([id]);
    });

    it("also closes the room when the host starts another live", async () => {
      const { alice, id } = await bigRoom();
      await goLive(alice, "Second");
      expect(lk.deleted).toContain(id);
    });

    it("closes the media room when the host deletes their account", async () => {
      const { alice, id } = await bigRoom();
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(lk.deleted).toContain(id);
      expect(await LiveSession.countDocuments({ _id: id })).toBe(0);
    });

    it("removes someone from the media room when the host blocks them, and the other way round", async () => {
      const { alice, id } = await bigRoom();
      const bob = await signup(app, "bob");
      const cara = await signup(app, "cara");
      await join(bob, id);
      await join(cara, id);
      await alice.agent.post("/api/users/bob/block");
      expect(lk.removed).toContainEqual([id, bob.user.id]);
      expect(await LiveListener.countDocuments({ session: id, user: bob.user.id })).toBe(0);
      await cara.agent.post("/api/users/alice/block");
      expect(lk.removed).toContainEqual([id, cara.user.id]);
    });
  });

  describe("keeping the database cool in a busy room", () => {
    it("remembers who is in the room between chat polls, and forgets the moment they leave", async () => {
      withKeys();
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const id = (await goLive(alice)).body.live.id;
      await join(bob, id);
      const spy = vi.spyOn(LiveListener, "findOne");
      for (let i = 0; i < 3; i++) expect((await bob.agent.get(`/api/live/${id}/comments`)).status).toBe(200);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1); // looked up once, then remembered
      spy.mockRestore();

      await bob.agent.post(`/api/live/${id}/leave`);
      expect((await bob.agent.get(`/api/live/${id}/comments`)).status).toBe(403); // not served from memory
    });

    it("forgets a block straight away", async () => {
      withKeys();
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const id = (await goLive(alice)).body.live.id;
      await join(bob, id);
      await bob.agent.post(`/api/live/${id}/comments`).send({ body: "hello" });
      expect((await alice.agent.get(`/api/live/${id}/comments`)).body.comments).toHaveLength(1);
      await alice.agent.post("/api/users/bob/block");
      expect((await alice.agent.get(`/api/live/${id}/comments`)).body.comments).toHaveLength(0);
      expect((await bob.agent.get(`/api/live/${id}/comments`)).status).toBe(403);
    });
  });
});
