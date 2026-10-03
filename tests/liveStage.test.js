import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

// The LiveKit management client is replaced by one that records what it was asked to do.
const lk = vi.hoisted(() => ({ created: [], deleted: [], removed: [], permissions: [], updateError: null }));
vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRoomServiceClient {
    async createRoom(opts) {
      lk.created.push(opts);
    }
    async deleteRoom(name) {
      lk.deleted.push(name);
    }
    async removeParticipant(room, identity) {
      lk.removed.push([room, identity]);
    }
    async updateParticipant(room, identity, options) {
      if (lk.updateError) throw new Error(lk.updateError);
      lk.permissions.push({ room, identity, ...options.permission });
    }
  }
  return { ...actual, RoomServiceClient: FakeRoomServiceClient };
});

const KEYS = { LIVEKIT_URL: "wss://demo-project.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "secret-secret-secret-secret-1234567" };

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  // sign-up is limited per address (10 an hour) and one test registers a dozen people, so each arrives from its own
  const res = await agent
    .post("/api/auth/register")
    .set("x-vercel-forwarded-for", `198.51.100.${++signups}`)
    .send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("the stage: the host brings listeners on to speak", () => {
  let app;
  let LiveListener;
  let User;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ LiveListener } = await import("../models/Live.js"));
    ({ User } = await import("../models/User.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
    lk.created.length = lk.deleted.length = lk.removed.length = lk.permissions.length = 0;
    lk.updateError = null;
    Object.assign(process.env, KEYS);
  });
  afterEach(() => {
    for (const k of Object.keys(KEYS)) delete process.env[k];
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const goLive = (who, title = "Open mic") => who.agent.post("/api/live").send({ title });
  const join = (who, id) => who.agent.post(`/api/live/${id}/join`);
  const stage = (who, id) => who.agent.get(`/api/live/${id}/stage`);
  const call = (who, id, action, body) => who.agent.post(`/api/live/${id}/stage/${action}`).send(body ?? {});

  async function room(listeners = ["lena"]) {
    const host = await signup(app, "hosty");
    const id = (await goLive(host)).body.live.id;
    const people = {};
    for (const name of listeners) {
      people[name] = await signup(app, name);
      await join(people[name], id);
    }
    return { host, id, ...people };
  }

  it("is only in lives that use the media server, and says so in the live's details", async () => {
    const { host, id } = await room([]);
    expect((await host.agent.get(`/api/live/${id}`)).body.live.maxGuests).toBe(9);
    expect((await stage(host, id)).body).toMatchObject({ enabled: true, maxGuests: 9, requests: [], invited: [], guests: [], listeners: [] });

    delete process.env.LIVEKIT_URL;
    const meshHost = await signup(app, "meshhost");
    const meshId = (await goLive(meshHost)).body.live.id;
    expect((await meshHost.agent.get(`/api/live/${meshId}`)).body.live.maxGuests).toBe(0);
    expect((await stage(meshHost, meshId)).body).toEqual({ enabled: false, maxGuests: 0, me: null, guests: [] });
    const lena = await signup(app, "lena2");
    await join(lena, meshId);
    for (const [who, action, body] of [[lena, "request"], [lena, "accept"], [lena, "leave"], [meshHost, "invite", { userId: lena.user.id }], [meshHost, "remove", { userId: lena.user.id }]]) {
      const res = await call(who, meshId, action, body);
      expect(res.status, action).toBe(409);
      expect(res.body.error).toMatch(/live audio service/);
    }
  });

  it("takes a listener from raising a hand, to being invited, to speaking", async () => {
    const { host, id, lena } = await room();

    expect((await stage(lena, id)).body).toMatchObject({ enabled: true, me: "listener", guests: [] });
    expect((await call(lena, id, "request")).body).toEqual({ stage: "requested" });
    expect((await stage(host, id)).body.requests.map((r) => r.user.username)).toEqual(["lena"]);

    expect((await call(host, id, "invite", { userId: lena.user.id })).body).toEqual({ stage: "invited" });
    const afterInvite = (await stage(host, id)).body;
    expect(afterInvite.requests).toEqual([]);
    expect(afterInvite.invited.map((r) => r.user.username)).toEqual(["lena"]);
    expect((await stage(lena, id)).body.me).toBe("invited");
    expect(lk.permissions).toEqual([]); // nothing is let through until she says yes

    expect((await call(lena, id, "accept")).body).toEqual({ stage: "speaking" });
    // her microphone — and only a microphone — is let through
    expect(lk.permissions).toEqual([{ room: id, identity: lena.user.id, canSubscribe: true, canPublish: true, canPublishData: false, canPublishSources: [2] }]);
    expect((await stage(lena, id)).body.me).toBe("speaking");
    expect((await stage(host, id)).body.guests.map((g) => g.user.username)).toEqual(["lena"]);
  });

  it("gives the host the list of everyone else who is listening to pick from", async () => {
    const { host, id, lena, bob } = await room(["lena", "bob"]);
    expect((await stage(host, id)).body.listeners.map((l) => l.user.username)).toEqual(["lena", "bob"]);
    await call(bob, id, "request");
    await call(host, id, "invite", { userId: lena.user.id });
    // people already asking, invited or speaking are in their own lists, not this one
    expect((await stage(host, id)).body.listeners).toEqual([]);
    await LiveListener.updateOne({ user: bob.user.id }, { $set: { stage: "listener", lastSeen: new Date(Date.now() - 5 * 60 * 1000) } });
    expect((await stage(host, id)).body.listeners).toEqual([]); // and someone who has gone quiet isn't offered
    const asLena = (await stage(lena, id)).body;
    expect(asLena).not.toHaveProperty("listeners"); // only the host sees who is listening
  });

  it("lets the host invite anyone listening, not only those who asked", async () => {
    const { host, id, lena } = await room();
    expect((await call(host, id, "invite", { userId: lena.user.id })).status).toBe(200);
    expect((await call(lena, id, "accept")).body.stage).toBe("speaking");
  });

  it("shows everyone in the room who is speaking, but only the host who is waiting", async () => {
    const { host, id, lena, bob } = await room(["lena", "bob"]);
    await call(bob, id, "request");
    await call(host, id, "invite", { userId: lena.user.id });
    await call(lena, id, "accept");
    const asBo = (await stage(bob, id)).body;
    expect(asBo.guests.map((g) => g.user.username)).toEqual(["lena"]);
    expect(asBo).not.toHaveProperty("requests");
    expect(asBo).not.toHaveProperty("invited");
    expect(asBo.me).toBe("requested");
  });

  it("won't put anyone on stage who hasn't been invited", async () => {
    const { id, lena } = await room();
    const res = await call(lena, id, "accept");
    expect(res.status).toBe(409);
    expect(lk.permissions).toEqual([]);
    await call(lena, id, "request"); // asking is not being invited
    expect((await call(lena, id, "accept")).status).toBe(409);
    expect(lk.permissions).toEqual([]);
  });

  it("keeps the controls to the right people", async () => {
    const { host, id, lena, bob } = await room(["lena", "bob"]);
    expect((await call(lena, id, "invite", { userId: bob.user.id })).status).toBe(403);
    expect((await call(lena, id, "remove", { userId: bob.user.id })).status).toBe(403);
    expect((await call(host, id, "request")).status).toBe(400);
    expect((await call(host, id, "accept")).status).toBe(400);
    expect((await call(host, id, "leave")).status).toBe(400);
    const stranger = await signup(app, "stranger");
    for (const res of [await stage(stranger, id), await call(stranger, id, "request")]) expect(res.status).toBe(403); // hasn't joined
  });

  it("only invites someone who is in the room, with a real id", async () => {
    const { host, id } = await room([]);
    const outsider = await signup(app, "outsider");
    expect((await call(host, id, "invite", { userId: outsider.user.id })).status).toBe(404);
    expect((await call(host, id, "invite", { userId: "nope" })).status).toBe(400);
    expect((await call(host, id, "invite", {})).status).toBe(400);
    expect((await call(host, id, "remove", { userId: new mongoose.Types.ObjectId().toString() })).status).toBe(404);
  });

  it("allows 9 guests at a time, counting invitations not yet answered, and frees a place when one leaves", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `guest${i}`);
    const { host, id, ...people } = await room(names);
    for (const name of names.slice(0, 9)) expect((await call(host, id, "invite", { userId: people[name].user.id })).status, name).toBe(200);
    // three have answered, six haven't: all nine places are still taken
    for (const name of names.slice(0, 3)) await call(people[name], id, "accept");
    const tenth = await call(host, id, "invite", { userId: people.guest9.user.id });
    expect(tenth.status).toBe(409);
    expect(tenth.body.error).toMatch(/full \(9 guests\)/);
    // inviting someone already invited or speaking is harmless and takes no extra place
    expect((await call(host, id, "invite", { userId: people.guest0.user.id })).status).toBe(200);

    await call(host, id, "remove", { userId: people.guest0.user.id });
    expect((await call(host, id, "invite", { userId: people.guest9.user.id })).status).toBe(200);
  }, 60_000);

  it("takes the microphone away when the host removes a guest, and also turns down a raised hand", async () => {
    const { host, id, lena, bob } = await room(["lena", "bob"]);
    await call(host, id, "invite", { userId: lena.user.id });
    await call(lena, id, "accept");
    lk.permissions.length = 0;

    expect((await call(host, id, "remove", { userId: lena.user.id })).body).toEqual({ stage: "listener" });
    expect(lk.permissions).toEqual([{ room: id, identity: lena.user.id, canSubscribe: true, canPublish: false, canPublishData: false, canPublishSources: [] }]);
    expect((await stage(lena, id)).body.me).toBe("listener");

    await call(bob, id, "request");
    expect((await call(host, id, "remove", { userId: bob.user.id })).status).toBe(200);
    expect((await stage(host, id)).body.requests).toEqual([]);
    expect(lk.permissions).toHaveLength(1); // nothing to take away from someone who never spoke
  });

  it("lets a guest step down, a request be withdrawn, and an invitation be turned down", async () => {
    const { host, id, lena, bob, cyd } = await room(["lena", "bob", "cyd"]);
    await call(host, id, "invite", { userId: lena.user.id });
    await call(lena, id, "accept");
    lk.permissions.length = 0;
    expect((await call(lena, id, "leave")).body).toEqual({ stage: "listener" });
    expect(lk.permissions).toEqual([{ room: id, identity: lena.user.id, canSubscribe: true, canPublish: false, canPublishData: false, canPublishSources: [] }]);

    await call(bob, id, "request");
    expect((await call(bob, id, "leave")).status).toBe(200);
    await call(host, id, "invite", { userId: cyd.user.id });
    expect((await call(cyd, id, "leave")).status).toBe(200);
    const snapshot = (await stage(host, id)).body;
    expect([snapshot.requests, snapshot.invited, snapshot.guests]).toEqual([[], [], []]);
    expect(lk.permissions).toHaveLength(1);
  });

  it("gives a guest who reconnects a pass that still lets them speak, and nobody else", async () => {
    const { host, id, lena, bob } = await room(["lena", "bob"]);
    const canPublish = async (who) => jwt.decode((await who.agent.post(`/api/live/${id}/token`)).body.token).video.canPublish;
    expect(await canPublish(host)).toBe(true);
    expect(await canPublish(lena)).toBe(false);
    await call(host, id, "invite", { userId: lena.user.id });
    expect(await canPublish(lena)).toBe(false); // invited is not yet speaking
    await call(lena, id, "accept");
    expect(await canPublish(lena)).toBe(true);
    expect(await canPublish(bob)).toBe(false);
    await call(host, id, "remove", { userId: lena.user.id });
    expect(await canPublish(lena)).toBe(false);
  });

  it("keeps the invitation if the guest isn't connected to the audio yet, or the media server fails", async () => {
    const { host, id, lena } = await room();
    await call(host, id, "invite", { userId: lena.user.id });

    lk.updateError = "participant does not exist";
    const early = await call(lena, id, "accept");
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/Connect to the live audio/);
    expect((await stage(lena, id)).body.me).toBe("invited");

    lk.updateError = "boom";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await call(lena, id, "accept");
    expect(failed.status).toBe(503);
    expect((await stage(lena, id)).body.me).toBe("invited");
    spy.mockRestore();

    lk.updateError = null;
    expect((await call(lena, id, "accept")).body.stage).toBe("speaking");
  });

  it("still sends a guest back to listening if the media server can't be reached to take the microphone away", async () => {
    const { host, id, lena } = await room();
    await call(host, id, "invite", { userId: lena.user.id });
    await call(lena, id, "accept");
    lk.updateError = "boom";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call(host, id, "remove", { userId: lena.user.id })).status).toBe(200);
    expect((await stage(lena, id)).body.me).toBe("listener");
    spy.mockRestore();
  });

  it("doesn't count or show people who have gone quiet", async () => {
    const { host, id, lena } = await room();
    await call(host, id, "invite", { userId: lena.user.id });
    await call(lena, id, "accept");
    await LiveListener.updateOne({ user: lena.user.id }, { $set: { lastSeen: new Date(Date.now() - 5 * 60 * 1000) } });
    expect((await stage(host, id)).body.guests).toEqual([]);
    expect((await call(host, id, "invite", { userId: lena.user.id })).status).toBe(404); // not here any more
  });

  it("removes a guest from the stage when they leave the live, or when either side blocks the other", async () => {
    const { host, id, lena, bob } = await room(["lena", "bob"]);
    for (const who of [lena, bob]) {
      await call(host, id, "invite", { userId: who.user.id });
      await call(who, id, "accept");
    }
    await lena.agent.post(`/api/live/${id}/leave`);
    expect((await stage(host, id)).body.guests.map((g) => g.user.username)).toEqual(["bob"]);

    await host.agent.post(`/api/users/${bob.user.username}/block`);
    expect((await stage(host, id)).body.guests).toEqual([]);
  });

  it("limits how many people can be asking at once", async () => {
    const { id, lena } = await room();
    const session = await LiveListener.findOne({ user: lena.user.id });
    const now = Date.now();
    await LiveListener.insertMany(
      Array.from({ length: 20 }, () => ({ session: session.session, user: new mongoose.Types.ObjectId(), lastSeen: new Date(now), expireAt: new Date(now + 600_000), stage: "requested" }))
    );
    const res = await call(lena, id, "request");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/asking to speak/);
  });

  it("ends the stage with the live", async () => {
    const { host, id, lena } = await room();
    await call(host, id, "invite", { userId: lena.user.id });
    await call(lena, id, "accept");
    await host.agent.post(`/api/live/${id}/end`);
    expect((await stage(lena, id)).status).toBe(409);
    expect(await LiveListener.countDocuments({ stage: { $ne: "listener" } })).toBe(0);
  });

  it("stores nothing but the stage position on a listener", async () => {
    const { id, lena } = await room();
    await call(lena, id, "request");
    const row = await LiveListener.findOne({ user: lena.user.id }).lean();
    expect(Object.keys(row).sort()).toEqual(["__v", "_id", "expireAt", "lastSeen", "session", "stage", "user"]);
    expect(await User.countDocuments()).toBe(2);
  });
});
