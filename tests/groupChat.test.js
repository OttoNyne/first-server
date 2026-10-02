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

describe("group chat", () => {
  let app;
  let GroupMessage;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ GroupMessage } = await import("../models/GroupMessage.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  async function groupWith(owner, ...others) {
    const created = await owner.agent.post("/api/groups").send({ name: "Painters", description: "Oils and acrylics" });
    const id = created.body.group.id;
    for (const o of others) await o.agent.post(`/api/groups/${id}/join`);
    return id;
  }
  const say = (who, id, body) => who.agent.post(`/api/groups/${id}/messages`).send({ body });

  it("requires sign-in", async () => {
    expect((await request(app).get("/api/groups/abc/messages")).status).toBe(401);
    expect((await request(app).post("/api/groups/abc/messages").send({ body: "hi" })).status).toBe(401);
    expect((await request(app).delete("/api/groups/abc/messages/def")).status).toBe(401);
  });

  it("is for members only: non-members can neither read nor write, and leaving ends access", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const id = await groupWith(alice);

    const outsiderRead = await bob.agent.get(`/api/groups/${id}/messages`);
    expect(outsiderRead.status).toBe(403);
    expect(outsiderRead.body.error).toMatch(/join/i);
    expect((await say(bob, id, "let me in")).status).toBe(403);
    expect((await alice.agent.get("/api/groups/507f1f77bcf86cd799439011/messages")).status).toBe(404);
    expect((await alice.agent.get("/api/groups/not-an-id/messages")).status).toBe(404);

    await say(alice, id, "welcome");
    await bob.agent.post(`/api/groups/${id}/join`);
    expect((await bob.agent.get(`/api/groups/${id}/messages`)).body.messages.map((m) => m.body)).toEqual(["welcome"]);

    await bob.agent.post(`/api/groups/${id}/leave`);
    expect((await bob.agent.get(`/api/groups/${id}/messages`)).status).toBe(403);
    expect((await say(bob, id, "still here?")).status).toBe(403);
  });

  it("shows who said what, in order, and marks your own", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const id = await groupWith(alice, bob);

    const first = await say(alice, id, "  Who is up for a critique night?  ");
    expect(first.status).toBe(201);
    expect(first.body.message).toMatchObject({ body: "Who is up for a critique night?", mine: true });
    expect(first.body.message.sender.username).toBe("alice");
    await say(bob, id, "Me!");

    const { messages, hasMore } = (await alice.agent.get(`/api/groups/${id}/messages`)).body;
    expect(hasMore).toBe(false);
    expect(messages.map((m) => [m.sender.username, m.body, m.mine])).toEqual([
      ["alice", "Who is up for a critique night?", true],
      ["bob", "Me!", false],
    ]);
  });

  it("keeps each group's chat separate", async () => {
    const alice = await signup(app, "alice");
    const a = await groupWith(alice);
    const b = (await alice.agent.post("/api/groups").send({ name: "Potters" })).body.group.id;
    await say(alice, a, "in painters");
    await say(alice, b, "in potters");
    expect((await alice.agent.get(`/api/groups/${a}/messages`)).body.messages.map((m) => m.body)).toEqual(["in painters"]);
  });

  it("validates: not empty, not too long, text only", async () => {
    const alice = await signup(app, "alice");
    const id = await groupWith(alice);
    expect((await say(alice, id, "   ")).status).toBe(400);
    expect((await say(alice, id, 7)).status).toBe(400);
    expect((await alice.agent.post(`/api/groups/${id}/messages`).send({})).status).toBe(400);
    expect((await say(alice, id, "x".repeat(1001))).status).toBe(400);
    expect((await say(alice, id, "x".repeat(1000))).status).toBe(201);
    expect(await GroupMessage.countDocuments()).toBe(1);
  });

  it("leaves out people you've blocked, and people who blocked you", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const cara = await signup(app, "cara");
    const id = await groupWith(alice, bob, cara);
    await say(bob, id, "from bob");
    await say(cara, id, "from cara");
    await say(alice, id, "from alice");

    await alice.agent.post("/api/users/bob/block");
    expect((await alice.agent.get(`/api/groups/${id}/messages`)).body.messages.map((m) => m.body)).toEqual(["from cara", "from alice"]);
    // and the block works the other way round too: bob no longer sees alice
    expect((await bob.agent.get(`/api/groups/${id}/messages`)).body.messages.map((m) => m.body)).toEqual(["from bob", "from cara"]);
    // cara still sees everyone
    expect((await cara.agent.get(`/api/groups/${id}/messages`)).body.messages).toHaveLength(3);
  });

  it("lets the sender or a group admin delete a message, and nobody else", async () => {
    const alice = await signup(app, "alice"); // creates the group, so is its admin
    const bob = await signup(app, "bob");
    const cara = await signup(app, "cara");
    const id = await groupWith(alice, bob, cara);
    const mine = (await say(bob, id, "bob's message")).body.message.id;
    const other = (await say(bob, id, "another")).body.message.id;

    expect((await cara.agent.delete(`/api/groups/${id}/messages/${mine}`)).status).toBe(404);
    expect((await bob.agent.delete(`/api/groups/${id}/messages/${mine}`)).status).toBe(204);
    expect((await alice.agent.delete(`/api/groups/${id}/messages/${other}`)).status).toBe(204); // admin
    expect(await GroupMessage.countDocuments()).toBe(0);
    expect((await alice.agent.delete(`/api/groups/${id}/messages/not-an-id`)).status).toBe(404);

    // a message from one group can't be deleted through another group's URL
    const second = (await alice.agent.post("/api/groups").send({ name: "Potters" })).body.group.id;
    const stray = (await say(alice, id, "stay")).body.message.id;
    expect((await alice.agent.delete(`/api/groups/${second}/messages/${stray}`)).status).toBe(404);
    expect(await GroupMessage.countDocuments()).toBe(1);
  });

  it("pages through a long chat", async () => {
    const alice = await signup(app, "alice");
    const id = await groupWith(alice);
    for (let i = 1; i <= 52; i++) await GroupMessage.create({ group: id, sender: alice.user.id, body: `m${i}` });

    const first = (await alice.agent.get(`/api/groups/${id}/messages`)).body;
    expect(first.hasMore).toBe(true);
    expect(first.messages).toHaveLength(50);
    expect(first.messages[0].body).toBe("m3");
    const older = (await alice.agent.get(`/api/groups/${id}/messages?before=${first.messages[0].id}`)).body;
    expect(older.hasMore).toBe(false);
    expect(older.messages.map((m) => m.body)).toEqual(["m1", "m2"]);
  });

  it("rate-limits sending per person", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const id = await groupWith(alice, bob);
    expect((await say(alice, id, "first")).status).toBe(201);
    const { RateLimitHit } = await import("../models/RateLimitHit.js");
    const now = Date.now();
    await RateLimitHit.insertMany(
      Array.from({ length: 59 }, () => ({ key: `group-chat:${alice.user.id}`, at: new Date(now), expireAt: new Date(now + 600000) }))
    );
    const limited = await say(alice, id, "too many");
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
    expect((await say(bob, id, "I can still talk")).status).toBe(201);
  });

  it("removes a person's messages when their account is deleted, and a group's when the group goes", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const id = await groupWith(alice, bob);
    await say(alice, id, "from alice");
    await say(bob, id, "from bob");

    expect((await bob.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
    expect((await alice.agent.get(`/api/groups/${id}/messages`)).body.messages.map((m) => m.body)).toEqual(["from alice"]);

    // alice is now the only member; deleting her deletes the empty group and its chat
    expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
    expect(await GroupMessage.countDocuments()).toBe(0);
  });
});
