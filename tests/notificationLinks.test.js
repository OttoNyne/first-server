import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

async function signup(app, name, { isPrivate = false } = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  if (isPrivate) await agent.patch("/api/profiles/me").send({ isPrivate: true });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("what a notification links to", () => {
  let app;
  let Notification;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Notification } = await import("../models/Notification.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const notes = async (who, type) => (await who.agent.get("/api/notifications")).body.notifications.filter((n) => !type || n.type === type);

  describe("opening a single post (GET /api/posts/:id)", () => {
    it("requires sign-in", async () => {
      expect((await request(app).get("/api/posts/507f1f77bcf86cd799439011")).status).toBe(401);
    });

    it("returns the post with its author and comment count", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const post = (await alice.agent.post("/api/posts").send({ content: "My new piece" })).body.post;
      await bob.agent.post(`/api/posts/${post.id}/comments`).send({ content: "Lovely" });

      const res = await bob.agent.get(`/api/posts/${post.id}`);
      expect(res.status).toBe(200);
      expect(res.body.post).toMatchObject({ id: post.id, content: "My new piece", commentCount: 1 });
      expect(res.body.post.author.username).toBe("alice");
      expect(JSON.stringify(res.body)).not.toContain("alice@example.com");
    });

    it("answers 404 for a post that doesn't exist, or an id that isn't one", async () => {
      const alice = await signup(app, "alice");
      expect((await alice.agent.get("/api/posts/507f1f77bcf86cd799439011")).status).toBe(404);
      expect((await alice.agent.get("/api/posts/not-an-id")).status).toBe(404);
    });

    it("answers 404, exactly as if it didn't exist, when the author is private and you aren't their friend", async () => {
      const alice = await signup(app, "alice", { isPrivate: true });
      const bob = await signup(app, "bob");
      const cara = await signup(app, "cara");
      const post = (await alice.agent.post("/api/posts").send({ content: "friends only" })).body.post;
      await befriend(alice, cara);

      const refused = await bob.agent.get(`/api/posts/${post.id}`);
      expect(refused.status).toBe(404);
      expect(refused.body.error).toBe("Post not found");
      expect((await cara.agent.get(`/api/posts/${post.id}`)).status).toBe(200); // a friend may
      expect((await alice.agent.get(`/api/posts/${post.id}`)).status).toBe(200); // and the author
    });

    it("answers 404 when either of you has blocked the other", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const post = (await alice.agent.post("/api/posts").send({ content: "hello" })).body.post;
      await bob.agent.post("/api/users/alice/block");
      expect((await bob.agent.get(`/api/posts/${post.id}`)).status).toBe(404);
      await bob.agent.delete("/api/users/alice/block");
      await alice.agent.post("/api/users/bob/block");
      expect((await bob.agent.get(`/api/posts/${post.id}`)).status).toBe(404);
    });

    it("gives the comment notification the ids it needs to link to the post", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const post = (await alice.agent.post("/api/posts").send({ content: "hi" })).body.post;
      const comment = (await bob.agent.post(`/api/posts/${post.id}/comments`).send({ content: "nice" })).body.comment;
      const [note] = await notes(alice, "comment");
      expect(note.payload).toMatchObject({ postId: post.id, commentId: comment.id });
      expect(note.actor.username).toBe("bob");
    });
  });

  describe("notifying someone of a direct message", () => {
    const say = (from, to, body) => from.agent.post(`/api/messages/with/${to.user.username}`).send({ body });

    it("tells the recipient who wrote, with a count, and the sender hears nothing", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await befriend(alice, bob);
      await say(alice, bob, "hello");

      const [note] = await notes(bob, "message");
      expect(note).toMatchObject({ type: "message", isRead: false, payload: { actorId: alice.user.id, count: 1 } });
      expect(note.actor.username).toBe("alice");
      expect(await notes(alice, "message")).toHaveLength(0);
    });

    it("keeps one notification per sender, with a rising count, and moves it to the top", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const cara = await signup(app, "cara");
      await befriend(alice, bob);
      await befriend(cara, bob);
      await say(alice, bob, "one");
      await say(cara, bob, "hi from cara");
      await say(alice, bob, "two");
      await say(alice, bob, "three");

      const list = await notes(bob, "message");
      expect(list).toHaveLength(2);
      expect(list[0].payload).toMatchObject({ actorId: alice.user.id, count: 3 }); // newest activity first
      expect(list[1].payload).toMatchObject({ actorId: cara.user.id, count: 1 });
    });

    it("marks it read when the conversation is opened, and the next message starts a fresh one", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await befriend(alice, bob);
      await say(alice, bob, "hello");
      await bob.agent.get(`/api/messages/with/${alice.user.username}`);
      expect((await notes(bob, "message"))[0].isRead).toBe(true);

      await say(alice, bob, "again");
      const list = await notes(bob, "message");
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({ isRead: false, payload: { count: 1 } });
    });

    it("only clears the notification for the conversation that was opened", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const cara = await signup(app, "cara");
      await befriend(alice, bob);
      await befriend(cara, bob);
      await say(alice, bob, "a");
      await say(cara, bob, "c");
      await bob.agent.get(`/api/messages/with/${alice.user.username}`);
      const byActor = Object.fromEntries((await notes(bob, "message")).map((n) => [n.actor.username, n.isRead]));
      expect(byActor).toEqual({ alice: true, cara: false });
    });

    it("sends nothing when the message is refused (not friends, blocked, empty)", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      expect((await say(alice, bob, "hello?")).status).toBe(403);
      await befriend(alice, bob);
      expect((await say(alice, bob, "   ")).status).toBe(400);
      expect(await Notification.countDocuments({ type: "message" })).toBe(0);
    });

    it("still delivers the message if the notification can't be saved", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await befriend(alice, bob);
      const original = Notification.create;
      Notification.create = async () => {
        throw new Error("database hiccup");
      };
      try {
        const res = await say(alice, bob, "still arrives");
        expect(res.status).toBe(201);
        expect((await bob.agent.get(`/api/messages/with/${alice.user.username}`)).body.messages).toHaveLength(1);
      } finally {
        Notification.create = original;
      }
    });

    it("goes when the sender deletes their account", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await befriend(alice, bob);
      await say(alice, bob, "bye");
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await notes(bob, "message")).toHaveLength(0);
    });
  });
});
