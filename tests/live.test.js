import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({
    email: `${name}@example.com`,
    username: name,
    password: "password123",
    displayName: name,
  });
  if (extra.private) await agent.patch("/api/profiles/me").send({ isPrivate: true });
  return { agent, user: res.body.user };
}

async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("voice live rooms", () => {
  let app;
  let LiveSession, LiveListener, LiveSignal, LiveComment;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ LiveSession, LiveListener, LiveSignal, LiveComment } = await import("../models/Live.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const goLive = (who, title = "Open mic night") => who.agent.post("/api/live").send({ title });
  const join = (who, id) => who.agent.post(`/api/live/${id}/join`);
  async function liveWith(host, ...listeners) {
    const id = (await goLive(host)).body.live.id;
    for (const l of listeners) expect((await join(l, id)).status).toBe(200);
    return id;
  }
  const offer = (from, id, to, data = { sdp: "v=0", cid: "c1" }) =>
    from.agent.post(`/api/live/${id}/signals`).send({ to, kind: "offer", data });

  it("requires sign-in everywhere", async () => {
    expect((await request(app).get("/api/live")).status).toBe(401);
    expect((await request(app).get("/api/live/ice")).status).toBe(401);
    expect((await request(app).post("/api/live").send({ title: "x" })).status).toBe(401);
    expect((await request(app).post("/api/live/abc/join")).status).toBe(401);
    expect((await request(app).get("/api/live/abc/signals")).status).toBe(401);
    expect((await request(app).post("/api/live/abc/comments").send({ body: "x" })).status).toBe(401);
  });

  it("starts a live and lists it with its host, title and listener count", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const started = await goLive(alice, "  Songwriting hour  ");
    expect(started.status).toBe(201);
    expect(started.body.live).toMatchObject({ title: "Songwriting hour", status: "live", isHost: true, listenerCount: 0, maxListeners: 8 });

    const { lives } = (await bob.agent.get("/api/live")).body;
    expect(lives).toHaveLength(1);
    expect(lives[0]).toMatchObject({ title: "Songwriting hour", isHost: false });
    expect(lives[0].host.username).toBe("alice");
    // the host's own email is never exposed to others
    expect(JSON.stringify(lives)).not.toContain("alice@example.com");
  });

  it("validates the title and limits how often someone can start a live", async () => {
    const alice = await signup(app, "alice");
    expect((await goLive(alice, "   ")).status).toBe(400);
    expect((await alice.agent.post("/api/live").send({})).status).toBe(400);
    expect((await goLive(alice, "x".repeat(81))).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await goLive(alice, `Live ${i}`)).status).toBe(201);
    const limited = await goLive(alice, "one more");
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
  });

  it("allows one live per person: starting another ends the first", async () => {
    const alice = await signup(app, "alice");
    const first = (await goLive(alice, "First")).body.live.id;
    const second = (await goLive(alice, "Second")).body.live.id;
    expect((await alice.agent.get(`/api/live/${first}`)).body.live.status).toBe("ended");
    expect((await alice.agent.get(`/api/live/${second}`)).body.live.status).toBe("live");
    expect((await alice.agent.get("/api/live")).body.lives.map((l) => l.title)).toEqual(["Second"]);
  });

  it("counts listeners who joined, and lets them leave", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const cara = await signup(app, "cara");
    const id = await liveWith(alice, bob, cara);
    expect((await alice.agent.get(`/api/live/${id}`)).body.live.listenerCount).toBe(2);
    expect((await bob.agent.post(`/api/live/${id}/leave`)).status).toBe(204);
    expect((await alice.agent.get(`/api/live/${id}`)).body.live.listenerCount).toBe(1);
    // rejoining doesn't double count
    await join(cara, id);
    expect((await alice.agent.get(`/api/live/${id}`)).body.live.listenerCount).toBe(1);
  });

  it("is full at 8 listeners, but a listener already in can rejoin", async () => {
    const host = await signup(app, "host");
    const id = (await goLive(host)).body.live.id;
    const people = [];
    for (let i = 0; i < 8; i++) {
      const p = await signup(app, `fan${i}`);
      expect((await join(p, id)).status).toBe(200);
      people.push(p);
    }
    const late = await signup(app, "late");
    const refused = await join(late, id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/full/);
    expect((await join(people[0], id)).status).toBe(200); // already in
  });

  it("won't let the host join their own live, or anyone join one that has ended", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const id = (await goLive(alice)).body.live.id;
    expect((await join(alice, id)).status).toBe(400);
    expect((await alice.agent.post(`/api/live/${id}/end`)).status).toBe(204);
    const late = await join(bob, id);
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/ended/);
    expect((await bob.agent.get("/api/live")).body.lives).toEqual([]);
  });

  it("only the host can end a live, and ending it removes the listeners and handshake messages", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const id = await liveWith(alice, bob);
    await offer(bob, id, alice.user.id);
    expect((await bob.agent.post(`/api/live/${id}/end`)).status).toBe(404);
    expect((await alice.agent.post(`/api/live/${id}/end`)).status).toBe(204);
    expect(await LiveListener.countDocuments({ session: id })).toBe(0);
    expect(await LiveSignal.countDocuments({ session: id })).toBe(0);
    const beat = await bob.agent.post(`/api/live/${id}/heartbeat`);
    expect(beat.status).toBe(403); // no longer a listener
    expect((await alice.agent.post(`/api/live/${id}/heartbeat`)).body.status).toBe("ended");
  });

  it("keeps a live alive with heartbeats, and treats a silent host as ended", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const id = await liveWith(alice, bob);
    const beat = await alice.agent.post(`/api/live/${id}/heartbeat`);
    expect(beat.body).toMatchObject({ status: "live", listenerCount: 1 });
    expect((await bob.agent.post(`/api/live/${id}/heartbeat`)).body.status).toBe("live");

    await LiveSession.updateOne({ _id: id }, { $set: { lastHeartbeat: new Date(Date.now() - 60_000) } });
    expect((await bob.agent.post(`/api/live/${id}/heartbeat`)).body.status).toBe("ended");
    expect((await bob.agent.get(`/api/live/${id}`)).body.live.status).toBe("ended");
    expect((await bob.agent.get("/api/live")).body.lives).toEqual([]);
    expect((await LiveSession.findById(id)).status).toBe("ended"); // tidied up by the list call
  });

  it("only counts listeners who pinged recently", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const id = await liveWith(alice, bob);
    await LiveListener.updateOne({ session: id }, { $set: { lastSeen: new Date(Date.now() - 60_000) } });
    expect((await alice.agent.get(`/api/live/${id}`)).body.live.listenerCount).toBe(0);
  });

  describe("who can see a live", () => {
    it("hides it from people who are blocked either way, as if it didn't exist", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const cara = await signup(app, "cara");
      const id = (await goLive(alice)).body.live.id;
      await alice.agent.post("/api/users/bob/block");

      expect((await bob.agent.get("/api/live")).body.lives).toEqual([]);
      expect((await bob.agent.get(`/api/live/${id}`)).status).toBe(404);
      expect((await join(bob, id)).status).toBe(404);
      expect((await cara.agent.get("/api/live")).body.lives).toHaveLength(1);

      // and the other direction: cara blocks alice
      await cara.agent.post("/api/users/alice/block");
      expect((await cara.agent.get("/api/live")).body.lives).toEqual([]);
      expect((await join(cara, id)).status).toBe(404);
    });

    it("shows a private profile's live only to their friends and themselves", async () => {
      const alice = await signup(app, "alice", { private: true });
      const friend = await signup(app, "friend");
      const stranger = await signup(app, "stranger");
      await befriend(alice, friend);
      const id = (await goLive(alice)).body.live.id;

      expect((await alice.agent.get("/api/live")).body.lives).toHaveLength(1);
      expect((await friend.agent.get("/api/live")).body.lives).toHaveLength(1);
      expect((await stranger.agent.get("/api/live")).body.lives).toEqual([]);
      expect((await join(stranger, id)).status).toBe(404);
      expect((await join(friend, id)).status).toBe(200);
    });

    it("cuts a listener off the moment the host blocks them, and the other way round", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const cara = await signup(app, "cara");
      const id = await liveWith(alice, bob, cara);
      await offer(bob, id, alice.user.id);

      await alice.agent.post("/api/users/bob/block");
      expect((await alice.agent.get(`/api/live/${id}`)).body.live.listenerCount).toBe(1); // bob is gone straight away
      expect(await LiveSignal.countDocuments({ session: id, from: bob.user.id })).toBe(0);
      expect((await bob.agent.post(`/api/live/${id}/heartbeat`)).status).toBe(404);
      expect((await bob.agent.get(`/api/live/${id}/signals`)).status).toBe(403);
      expect((await bob.agent.get(`/api/live/${id}/comments`)).status).toBe(403);
      expect((await bob.agent.post(`/api/live/${id}/comments`).send({ body: "hi" })).status).toBe(403);
      expect((await join(bob, id)).status).toBe(404);

      // a listener who blocks the host leaves that host's live too
      await cara.agent.post("/api/users/alice/block");
      expect((await alice.agent.get(`/api/live/${id}`)).body.live.listenerCount).toBe(0);
      expect((await cara.agent.get(`/api/live/${id}/signals`)).status).toBe(403); // no longer in the room
    });
  });

  describe("handshake messages", () => {
    it("passes an offer from a listener to the host and an answer back, in order, only to the recipient", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const cara = await signup(app, "cara");
      const id = await liveWith(alice, bob, cara);

      expect((await offer(bob, id, alice.user.id, { sdp: "bob-offer", cid: "b1" })).status).toBe(201);
      expect((await offer(cara, id, alice.user.id, { sdp: "cara-offer", cid: "c1" })).status).toBe(201);
      const forHost = (await alice.agent.get(`/api/live/${id}/signals`)).body.signals;
      expect(forHost.map((s) => [s.from, s.kind, s.data.sdp])).toEqual([
        [bob.user.id, "offer", "bob-offer"],
        [cara.user.id, "offer", "cara-offer"],
      ]);

      await alice.agent.post(`/api/live/${id}/signals`).send({ to: bob.user.id, kind: "answer", data: { sdp: "answer-for-bob", cid: "b1" } });
      const forBob = (await bob.agent.get(`/api/live/${id}/signals`)).body.signals;
      expect(forBob.map((s) => s.data.sdp)).toEqual(["answer-for-bob"]);
      // cara sees nothing meant for bob
      expect((await cara.agent.get(`/api/live/${id}/signals`)).body.signals).toEqual([]);
    });

    it("returns only newer messages when given a cursor", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const id = await liveWith(alice, bob);
      await offer(bob, id, alice.user.id, { n: 1 });
      await bob.agent.post(`/api/live/${id}/signals`).send({ to: alice.user.id, kind: "ice", data: { n: 2 } });
      const first = (await alice.agent.get(`/api/live/${id}/signals`)).body.signals;
      expect(first).toHaveLength(2);
      expect((await alice.agent.get(`/api/live/${id}/signals?after=${first[1].id}`)).body.signals).toEqual([]);
      expect((await alice.agent.get(`/api/live/${id}/signals?after=${first[0].id}`)).body.signals.map((s) => s.data.n)).toEqual([2]);
    });

    it("lets a listener talk only to the host, and the host only to listeners", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const cara = await signup(app, "cara");
      const dan = await signup(app, "dan");
      const id = await liveWith(alice, bob, cara);

      expect((await offer(bob, id, cara.user.id)).status).toBe(403); // listener to listener
      expect((await offer(dan, id, alice.user.id)).status).toBe(403); // hasn't joined
      expect((await alice.agent.post(`/api/live/${id}/signals`).send({ to: dan.user.id, kind: "answer", data: { x: 1 } })).status).toBe(404); // not a listener
      expect((await dan.agent.get(`/api/live/${id}/signals`)).status).toBe(403);
      expect(await LiveSignal.countDocuments()).toBe(0);
    });

    it("rejects malformed or oversized messages", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const id = await liveWith(alice, bob);
      const post = (body) => bob.agent.post(`/api/live/${id}/signals`).send(body);
      expect((await post({ to: alice.user.id, kind: "bogus", data: {} })).status).toBe(400);
      expect((await post({ to: alice.user.id, kind: "offer" })).status).toBe(400);
      expect((await post({ to: alice.user.id, kind: "offer", data: "text" })).status).toBe(400);
      expect((await post({ to: "not-an-id", kind: "offer", data: {} })).status).toBe(400);
      expect((await post({ to: { $ne: "" }, kind: "offer", data: {} })).status).toBe(400);
      expect((await post({ to: alice.user.id, kind: "offer", data: { sdp: "x".repeat(21_000) } })).status).toBe(400);
    });

    it("refuses messages once the live has ended", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const id = await liveWith(alice, bob);
      await alice.agent.post(`/api/live/${id}/end`);
      expect((await offer(bob, id, alice.user.id)).status).toBe(409);
    });
  });

  describe("ice servers", () => {
    it("defaults to public STUN, and uses LIVE_ICE_SERVERS (e.g. a TURN relay) when set", async () => {
      const alice = await signup(app, "alice");
      const def = (await alice.agent.get("/api/live/ice")).body.iceServers;
      expect(def[0].urls.join(" ")).toMatch(/^stun:/);

      process.env.LIVE_ICE_SERVERS = JSON.stringify([{ urls: "turn:turn.example.com:3478", username: "u", credential: "p" }]);
      try {
        expect((await alice.agent.get("/api/live/ice")).body.iceServers).toEqual([{ urls: "turn:turn.example.com:3478", username: "u", credential: "p" }]);
        process.env.LIVE_ICE_SERVERS = "not json";
        expect((await alice.agent.get("/api/live/ice")).body.iceServers).toEqual(def);
        process.env.LIVE_ICE_SERVERS = JSON.stringify([{ nope: 1 }]);
        expect((await alice.agent.get("/api/live/ice")).body.iceServers).toEqual(def);
      } finally {
        delete process.env.LIVE_ICE_SERVERS;
      }
    });
  });

  describe("live chat", () => {
    it("lets the host and listeners chat, in order, and marks your own", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const id = await liveWith(alice, bob);
      const sent = await bob.agent.post(`/api/live/${id}/comments`).send({ body: "  Love this one!  " });
      expect(sent.status).toBe(201);
      expect(sent.body.comment).toMatchObject({ body: "Love this one!", mine: true });
      await alice.agent.post(`/api/live/${id}/comments`).send({ body: "Thank you" });

      const list = (await bob.agent.get(`/api/live/${id}/comments`)).body.comments;
      expect(list.map((c) => [c.user.username, c.body, c.mine])).toEqual([
        ["bob", "Love this one!", true],
        ["alice", "Thank you", false],
      ]);
      // polling with a cursor returns only what's new
      await bob.agent.post(`/api/live/${id}/comments`).send({ body: "encore!" });
      expect((await bob.agent.get(`/api/live/${id}/comments?after=${list[1].id}`)).body.comments.map((c) => c.body)).toEqual(["encore!"]);
    });

    it("is for people in the room: others can't read or write, and nothing new after it ends", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const dan = await signup(app, "dan");
      const id = await liveWith(alice, bob);
      expect((await dan.agent.get(`/api/live/${id}/comments`)).status).toBe(403);
      expect((await dan.agent.post(`/api/live/${id}/comments`).send({ body: "hi" })).status).toBe(403);
      await alice.agent.post(`/api/live/${id}/end`);
      expect((await alice.agent.post(`/api/live/${id}/comments`).send({ body: "bye" })).status).toBe(409);
    });

    it("validates and rate limits comments", async () => {
      const alice = await signup(app, "alice");
      const id = (await goLive(alice)).body.live.id;
      const say = (body) => alice.agent.post(`/api/live/${id}/comments`).send({ body });
      expect((await say("   ")).status).toBe(400);
      expect((await say(5)).status).toBe(400);
      expect((await say("x".repeat(201))).status).toBe(400);
      for (let i = 0; i < 20; i++) expect((await say(`c${i}`)).status).toBe(201);
      const limited = await say("too many");
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeTruthy();
    });

    it("hides comments from people you've blocked, and lets the author or host delete one", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const cara = await signup(app, "cara");
      const id = await liveWith(alice, bob, cara);
      const bobs = (await bob.agent.post(`/api/live/${id}/comments`).send({ body: "from bob" })).body.comment.id;
      const caras = (await cara.agent.post(`/api/live/${id}/comments`).send({ body: "from cara" })).body.comment.id;

      await cara.agent.post("/api/users/bob/block");
      expect((await cara.agent.get(`/api/live/${id}/comments`)).body.comments.map((c) => c.body)).toEqual(["from cara"]);

      expect((await cara.agent.delete(`/api/live/${id}/comments/${bobs}`)).status).toBe(404); // not hers
      expect((await bob.agent.delete(`/api/live/${id}/comments/${bobs}`)).status).toBe(204); // author
      expect((await alice.agent.delete(`/api/live/${id}/comments/${caras}`)).status).toBe(204); // host
      expect(await LiveComment.countDocuments()).toBe(0);
      expect((await alice.agent.delete(`/api/live/${id}/comments/nope`)).status).toBe(404);
    });
  });

  describe("telling friends", () => {
    let Notification;
    beforeAll(async () => {
      ({ Notification } = await import("../models/Notification.js"));
    });
    const notesFor = (u) => Notification.find({ recipient: u.user.id, type: "live_started" });

    it("notifies the host's friends, with who and what, and nobody else", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const cara = await signup(app, "cara");
      const stranger = await signup(app, "stranger");
      await befriend(alice, bob);
      await befriend(alice, cara);
      const id = (await goLive(alice, "Mixing a new track")).body.live.id;

      for (const friend of [bob, cara]) {
        const notes = await notesFor(friend);
        expect(notes).toHaveLength(1);
        expect(notes[0].payload).toMatchObject({ actorId: alice.user.id, liveId: id, title: "Mixing a new track" });
      }
      expect(await notesFor(stranger)).toHaveLength(0);
      expect(await notesFor(alice)).toHaveLength(0); // not the host themselves
    });

    it("shows up in the friend's notifications with the host as the actor", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await befriend(alice, bob);
      const id = (await goLive(alice, "Open mic")).body.live.id;
      const { notifications } = (await bob.agent.get("/api/notifications")).body;
      expect(notifications[0]).toMatchObject({ type: "live_started", isRead: false, payload: { liveId: id, title: "Open mic" } });
      expect(notifications[0].actor.username).toBe("alice");
    });

    it("doesn't notify someone who is no longer a friend or has blocked the host", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const cara = await signup(app, "cara");
      await befriend(alice, bob);
      await befriend(alice, cara);
      await bob.agent.delete(`/api/friends/${alice.user.id}`);
      await cara.agent.post("/api/users/alice/block");
      await goLive(alice);
      expect(await notesFor(bob)).toHaveLength(0);
      expect(await notesFor(cara)).toHaveLength(0);
    });

    it("works for a private-profile host (their friends are the only ones who could see it anyway)", async () => {
      const alice = await signup(app, "alice", { private: true });
      const bob = await signup(app, "bob");
      await befriend(alice, bob);
      await goLive(alice);
      expect(await notesFor(bob)).toHaveLength(1);
    });

    it("removes the notification when the live ends, however it ends", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await befriend(alice, bob);

      const first = (await goLive(alice, "One")).body.live.id;
      expect(await notesFor(bob)).toHaveLength(1);
      expect((await alice.agent.post(`/api/live/${first}/end`)).status).toBe(204);
      expect(await notesFor(bob)).toHaveLength(0);

      // starting a second live ends the first and replaces its notification
      await goLive(alice, "Two");
      await goLive(alice, "Three");
      const notes = await notesFor(bob);
      expect(notes).toHaveLength(1);
      expect(notes[0].payload.title).toBe("Three");

      // and a host who simply vanishes: the server's cleanup removes it too
      await LiveSession.updateOne({ title: "Three" }, { $set: { lastHeartbeat: new Date(Date.now() - 60_000) } });
      await bob.agent.get("/api/live");
      expect(await notesFor(bob)).toHaveLength(0);
    });

    it("still starts the live if telling friends goes wrong", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await befriend(alice, bob);
      const original = Notification.insertMany;
      Notification.insertMany = async () => {
        throw new Error("database hiccup");
      };
      try {
        const res = await goLive(alice, "Still on");
        expect(res.status).toBe(201);
        expect((await alice.agent.get("/api/live")).body.lives).toHaveLength(1);
      } finally {
        Notification.insertMany = original;
      }
    });

    it("is removed with the host's account", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await befriend(alice, bob);
      await goLive(alice);
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await notesFor(bob)).toHaveLength(0);
    });
  });

  it("removes a person's lives, listening and comments when their account is deleted", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const cara = await signup(app, "cara");
    const aliceLive = await liveWith(alice, bob);
    await bob.agent.post(`/api/live/${aliceLive}/comments`).send({ body: "hello" });
    await offer(bob, aliceLive, alice.user.id);
    const caraLive = await liveWith(cara, bob);
    await bob.agent.post(`/api/live/${caraLive}/comments`).send({ body: "hi cara" });

    // a listener deleting their account leaves the host's live intact
    expect((await bob.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
    expect(await LiveListener.countDocuments({ user: bob.user.id })).toBe(0);
    expect(await LiveComment.countDocuments({ user: bob.user.id })).toBe(0);
    expect(await LiveSignal.countDocuments({ from: bob.user.id })).toBe(0);
    expect((await cara.agent.get(`/api/live/${caraLive}`)).body.live.status).toBe("live");

    // a host deleting theirs removes their live and everything in it
    expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
    expect(await LiveSession.countDocuments({ host: alice.user.id })).toBe(0);
    expect(await LiveSignal.countDocuments({ session: aliceLive })).toBe(0);
  });
});
