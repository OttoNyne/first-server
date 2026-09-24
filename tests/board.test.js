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

describe("help wanted board", () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  it("keeps requests private by default and shows public ones to others only", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    await alice.agent.post("/api/tasks").send({ title: "secret" });
    await alice.agent.post("/api/tasks").send({ title: "logo help", description: "need a logo", isPublic: true });

    const board = await bob.agent.get("/api/tasks/board");
    expect(board.status).toBe(200);
    expect(board.body.tasks.map((t) => t.title)).toEqual(["logo help"]);
    expect(board.body.tasks[0].author.username).toBe("alice");

    // the owner's own requests aren't on their own board
    const own = await alice.agent.get("/api/tasks/board");
    expect(own.body.tasks).toEqual([]);
  });

  it("requires auth and hides done requests", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    expect((await request(app).get("/api/tasks/board")).status).toBe(401);
    const t = await alice.agent.post("/api/tasks").send({ title: "x", isPublic: true });
    await alice.agent.put(`/api/tasks/${t.body._id}`).send({ done: true });
    expect((await bob.agent.get("/api/tasks/board")).body.tasks).toEqual([]);
  });

  it("hides requests from blocked users and private-profile strangers", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const carol = await signup(app, "carol");
    await alice.agent.post("/api/tasks").send({ title: "a", isPublic: true });
    await carol.agent.post("/api/tasks").send({ title: "c", isPublic: true });

    await bob.agent.post("/api/users/alice/block");
    await carol.agent.patch("/api/profiles/me").send({ isPrivate: true });

    const board = await bob.agent.get("/api/tasks/board");
    expect(board.body.tasks).toEqual([]);
  });

  it("lets others offer help once, notifying the owner", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const t = await alice.agent.post("/api/tasks").send({ title: "logo help", isPublic: true });

    expect((await bob.agent.post(`/api/tasks/${t.body._id}/offer`)).status).toBe(201);
    expect((await bob.agent.post(`/api/tasks/${t.body._id}/offer`)).status).toBe(201);

    const notes = await alice.agent.get("/api/notifications");
    const offers = notes.body.notifications.filter((n) => n.type === "help_offer");
    expect(offers).toHaveLength(1);
    expect(offers[0].actor.username).toBe("bob");
    expect(offers[0].payload.title).toBe("logo help");
  });

  it("rejects offers on own, private, or missing requests", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const pub = await alice.agent.post("/api/tasks").send({ title: "p", isPublic: true });
    const priv = await alice.agent.post("/api/tasks").send({ title: "q" });

    expect((await alice.agent.post(`/api/tasks/${pub.body._id}/offer`)).status).toBe(400);
    expect((await bob.agent.post(`/api/tasks/${priv.body._id}/offer`)).status).toBe(404);
    expect((await bob.agent.post("/api/tasks/not-an-id/offer")).status).toBe(400);
  });

  it("never exposes another user's email, but still shows you your own", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    await alice.agent.post("/api/tasks").send({ title: "x", isPublic: true });

    const board = await bob.agent.get("/api/tasks/board");
    expect(board.body.tasks[0].author.email).toBeUndefined();
    expect((await bob.agent.get("/api/profiles/alice")).body.user.email).toBeUndefined();
    expect((await bob.agent.get("/api/profiles?search=alice")).body.users[0].email).toBeUndefined();
    expect((await bob.agent.get("/api/auth/me")).body.user.email).toBe("bob@example.com");
  });

  it("doesn't let the create body set the owner or done state", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const t = await alice.agent.post("/api/tasks").send({ title: "x", owner: bob.user.id, done: true });
    expect(t.body.owner).toBe(alice.user.id);
    expect(t.body.done).toBe(false);
  });
});
