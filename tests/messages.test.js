import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({
    email: `${name}@example.com`,
    username: name,
    password: "password123",
    displayName: name,
  });
  return { agent, user: res.body.user };
}

async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("direct messages", () => {
  let app;
  let Message;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Message } = await import("../models/Message.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const send = (from, to, body) => from.agent.post(`/api/messages/with/${to.user.username}`).send({ body });

  it("requires sign-in for every route", async () => {
    expect((await request(app).get("/api/messages/conversations")).status).toBe(401);
    expect((await request(app).get("/api/messages/unread-count")).status).toBe(401);
    expect((await request(app).get("/api/messages/with/bob")).status).toBe(401);
    expect((await request(app).post("/api/messages/with/bob").send({ body: "hi" })).status).toBe(401);
    expect((await request(app).delete("/api/messages/abc")).status).toBe(401);
  });

  it("only lets friends message each other", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");

    const stranger = await send(alice, bob, "hello?");
    expect(stranger.status).toBe(403);
    expect(stranger.body.error).toMatch(/friends/i);
    expect((await alice.agent.get("/api/messages/with/bob")).status).toBe(403);

    // a pending (unaccepted) request isn't enough
    await alice.agent.post("/api/friends/request/bob");
    expect((await send(alice, bob, "hello?")).status).toBe(403);

    const req = await bob.agent.get("/api/friends/requests");
    await bob.agent.post(`/api/friends/accept/${req.body.requests[0].id}`);
    expect((await send(alice, bob, "hello!")).status).toBe(201);
  });

  it("delivers a message, marks it read when the recipient opens the thread, and tracks the unread count", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    await befriend(alice, bob);

    const sent = await send(alice, bob, "  Are you free Friday?  ");
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({ body: "Are you free Friday?", mine: true, readAt: null });
    await send(alice, bob, "Studio at 3?");

    expect((await bob.agent.get("/api/messages/unread-count")).body.unread).toBe(2);
    expect((await alice.agent.get("/api/messages/unread-count")).body.unread).toBe(0);

    const thread = await bob.agent.get("/api/messages/with/alice");
    expect(thread.status).toBe(200);
    expect(thread.body.messages.map((m) => m.body)).toEqual(["Are you free Friday?", "Studio at 3?"]);
    expect(thread.body.messages.every((m) => m.mine === false)).toBe(true);
    expect(thread.body.user.username).toBe("alice");

    expect((await bob.agent.get("/api/messages/unread-count")).body.unread).toBe(0);
    // Alice's own view shows them as hers, and now read
    const aliceView = await alice.agent.get("/api/messages/with/bob");
    expect(aliceView.body.messages.every((m) => m.mine && m.readAt)).toBe(true);
  });

  it("lists conversations newest first with unread counts, including friends you haven't written to", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const cara = await signup(app, "cara");
    const dan = await signup(app, "dan");
    await befriend(alice, bob);
    await befriend(alice, cara);
    await befriend(alice, dan);
    await send(bob, alice, "first");
    await send(cara, alice, "second");
    await send(cara, alice, "third");

    const { conversations } = (await alice.agent.get("/api/messages/conversations")).body;
    expect(conversations.map((c) => c.user.username)).toEqual(["cara", "bob", "dan"]);
    expect(conversations[0]).toMatchObject({ unread: 2, lastMessage: { body: "third", mine: false } });
    expect(conversations[1].unread).toBe(1);
    expect(conversations[2]).toMatchObject({ unread: 0, lastMessage: null });

    // strangers never appear
    const eve = await signup(app, "eve");
    expect((await eve.agent.get("/api/messages/conversations")).body.conversations).toEqual([]);
  });

  it("validates the message: not empty, not too long, must be text", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    await befriend(alice, bob);

    expect((await send(alice, bob, "   ")).status).toBe(400);
    expect((await send(alice, bob, 42)).status).toBe(400);
    expect((await alice.agent.post("/api/messages/with/bob").send({})).status).toBe(400);
    expect((await send(alice, bob, "x".repeat(2001))).status).toBe(400);
    expect((await send(alice, bob, "x".repeat(2000))).status).toBe(201);
    expect(await Message.countDocuments()).toBe(1);
  });

  it("won't message yourself or an unknown user", async () => {
    const alice = await signup(app, "alice");
    expect((await send(alice, alice, "hi me")).status).toBe(400);
    expect((await alice.agent.post("/api/messages/with/nobody").send({ body: "hi" })).status).toBe(404);
  });

  it("stops in both directions once either person blocks the other or they unfriend", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    await befriend(alice, bob);
    await send(alice, bob, "before the block");

    await bob.agent.post("/api/users/alice/block");
    expect((await send(alice, bob, "still there?")).status).toBe(403);
    expect((await send(bob, alice, "sorry")).status).toBe(403);
    expect((await alice.agent.get("/api/messages/with/bob")).status).toBe(403);
    expect((await bob.agent.get("/api/messages/with/alice")).status).toBe(403);
  });

  it("stops after unfriending and hides the conversation", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    await befriend(alice, bob);
    await send(alice, bob, "hi");
    await alice.agent.delete(`/api/friends/${bob.user.id}`);

    expect((await send(bob, alice, "wait")).status).toBe(403);
    expect((await alice.agent.get("/api/messages/conversations")).body.conversations).toEqual([]);
  });

  it("lets only the sender delete a message, for both people", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const cara = await signup(app, "cara");
    await befriend(alice, bob);
    const { message } = (await send(alice, bob, "oops")).body;

    expect((await bob.agent.delete(`/api/messages/${message.id}`)).status).toBe(404);
    expect((await cara.agent.delete(`/api/messages/${message.id}`)).status).toBe(404);
    expect((await alice.agent.delete("/api/messages/not-an-id")).status).toBe(404);
    expect(await Message.countDocuments()).toBe(1);

    expect((await alice.agent.delete(`/api/messages/${message.id}`)).status).toBe(204);
    expect((await bob.agent.get("/api/messages/with/alice")).body.messages).toEqual([]);
  });

  it("pages through a long conversation, oldest of each page first", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    await befriend(alice, bob);
    for (let i = 1; i <= 55; i++) await Message.create({ sender: alice.user.id, recipient: bob.user.id, pair: [alice.user.id, bob.user.id].sort().join(":"), body: `m${i}` });

    const first = (await bob.agent.get("/api/messages/with/alice")).body;
    expect(first.hasMore).toBe(true);
    expect(first.messages).toHaveLength(50);
    expect(first.messages[0].body).toBe("m6");
    expect(first.messages.at(-1).body).toBe("m55");

    const older = (await bob.agent.get(`/api/messages/with/alice?before=${first.messages[0].id}`)).body;
    expect(older.hasMore).toBe(false);
    expect(older.messages.map((m) => m.body)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("rate-limits sending", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    await befriend(alice, bob);
    expect((await send(alice, bob, "the first")).status).toBe(201);
    // Fill the rest of her allowance directly instead of sending 59 real requests.
    const { RateLimitHit } = await import("../models/RateLimitHit.js");
    const now = Date.now();
    await RateLimitHit.insertMany(
      Array.from({ length: 59 }, () => ({ key: `message-send:${alice.user.id}`, at: new Date(now), expireAt: new Date(now + 600000) }))
    );
    const limited = await send(alice, bob, "one too many");
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
    // and it's per sender: Bob can still reply
    expect((await send(bob, alice, "hi")).status).toBe(201);
  });

  it("removes their messages when an account is deleted", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const cara = await signup(app, "cara");
    await befriend(alice, bob);
    await befriend(bob, cara);
    await send(alice, bob, "to bob");
    await send(bob, alice, "to alice");
    await send(bob, cara, "unrelated");

    expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
    expect(await Message.countDocuments()).toBe(1);
    expect((await cara.agent.get("/api/messages/with/bob")).body.messages.map((m) => m.body)).toEqual(["unrelated"]);
  });
});
