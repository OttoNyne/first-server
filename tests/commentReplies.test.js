import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.117.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("replies in comment threads", () => {
  let app, Notification, Comment, MediaComment, BlogComment;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Notification } = await import("../models/Notification.js"));
    ({ Comment } = await import("../models/Comment.js"));
    ({ MediaComment } = await import("../models/MediaComment.js"));
    ({ BlogComment } = await import("../models/BlogComment.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  // the three places comments live, each with the same behaviour
  const kinds = {
    post: {
      make: async (owner) => (await owner.agent.post("/api/posts").send({ content: "A post" })).body.post.id,
      add: (who, id, body) => who.agent.post(`/api/posts/${id}/comments`).send(body),
      list: (who, id) => who.agent.get(`/api/posts/${id}/comments`),
      remove: (who, commentId) => who.agent.delete(`/api/comments/${commentId}`),
      url: (id, commentId) => `/posts/${id}?comment=${commentId}`,
      model: () => Comment,
    },
    piece: {
      make: async (owner) => (await owner.agent.post("/api/media").send({ type: "image", url: "https://img.example.com/a.png" })).body.mediaItem.id,
      add: (who, id, body) => who.agent.post(`/api/media/${id}/comments`).send(body),
      list: (who, id) => who.agent.get(`/api/media/${id}/comments`),
      remove: (who, commentId) => who.agent.delete(`/api/media/comments/${commentId}`),
      url: (id, commentId, owner) => `/u/${owner}?piece=${id}&comment=${commentId}#portfolio`,
      model: () => MediaComment,
    },
    blog: {
      make: async (owner) => (await owner.agent.post("/api/blog").send({ title: "Notes", body: "Some notes" })).body.entry.id,
      add: (who, id, body) => who.agent.post(`/api/blog/${id}/comments`).send(body),
      list: (who, id) => who.agent.get(`/api/blog/${id}/comments`),
      remove: (who, commentId) => who.agent.delete(`/api/blog/comments/${commentId}`),
      url: (id, commentId) => `/blog/${id}?comment=${commentId}`,
      model: () => BlogComment,
    },
  };

  for (const [name, k] of Object.entries(kinds)) {
    describe(`on a ${name}`, () => {
      async function thread() {
        const owner = await signup(app, "owner");
        const bob = await signup(app, "bobby");
        const cara = await signup(app, "carla");
        const id = await k.make(owner);
        const top = (await k.add(bob, id, { content: "First comment" })).body.comment;
        return { owner, bob, cara, id, top };
      }

      it("shows a reply under its comment, saying which one it answers", async () => {
        const { cara, id, top } = await thread();
        const res = await k.add(cara, id, { content: "A reply", parent: top.id });
        expect(res.status).toBe(201);
        expect(res.body.comment.parent).toBe(top.id);
        const all = (await k.list(cara, id)).body.comments;
        expect(all.map((c) => [c.content, c.parent])).toEqual([["First comment", null], ["A reply", top.id]]);
      });

      it("keeps a reply to a reply under the same top-level comment", async () => {
        const { owner, cara, id, top } = await thread();
        const reply = (await k.add(cara, id, { content: "reply", parent: top.id })).body.comment;
        const deeper = await k.add(owner, id, { content: "answer to the reply", parent: reply.id });
        expect(deeper.status).toBe(201);
        expect(deeper.body.comment.parent).toBe(top.id);
      });

      it("refuses a parent that isn't a comment here, or isn't an id", async () => {
        const { owner, cara, id, top } = await thread();
        const otherId = await k.make(owner);
        const elsewhere = (await k.add(cara, otherId, { content: "on the other one" })).body.comment;
        for (const bad of [elsewhere.id, "0123456789abcdef01234567", "nonsense", 5, {}]) {
          const res = await k.add(cara, id, { content: "x", parent: bad });
          expect(res.status, JSON.stringify(bad)).toBe(400);
          expect(res.body.error).toBe("That comment can't be replied to");
        }
        expect(await k.model().countDocuments({ parent: top.id })).toBe(0);
        expect((await k.add(cara, id, { content: "a normal comment", parent: null })).body.comment.parent).toBeNull();
      });

      it("tells the person whose comment was answered, with where to go, and not for answering yourself", async () => {
        const { owner, bob, cara, id, top } = await thread();
        const res = await k.add(cara, id, { content: "reply", parent: top.id });
        const note = await Notification.findOne({ recipient: bob.user.id, type: "reply" }).lean();
        expect(note.payload).toMatchObject({ actorId: cara.user.id, url: k.url(id, res.body.comment.id, "owner") });
        await k.add(bob, id, { content: "answering myself", parent: top.id });
        expect(await Notification.countDocuments({ recipient: bob.user.id, type: "reply" })).toBe(1);
        void owner;
      });

      it("doesn't tell someone twice when they own the thing and wrote the comment answered", async () => {
        const { owner, cara, id } = await thread();
        const ownersComment = (await k.add(owner, id, { content: "mine" })).body.comment;
        await k.add(cara, id, { content: "reply to the owner", parent: ownersComment.id });
        expect(await Notification.countDocuments({ recipient: owner.user.id, type: "reply" })).toBe(0);
        expect(await Notification.countDocuments({ recipient: owner.user.id })).toBeGreaterThan(0); // told about the comment as usual
      });

      it("doesn't tell someone who blocked the writer", async () => {
        const { bob, cara, id, top } = await thread();
        await bob.agent.post("/api/users/carla/block");
        await k.add(cara, id, { content: "reply", parent: top.id });
        expect(await Notification.countDocuments({ recipient: bob.user.id, type: "reply" })).toBe(0);
      });

      it("takes the replies down with the comment, and leaves the others alone when one reply goes", async () => {
        const { bob, cara, id, top } = await thread();
        const first = (await k.add(cara, id, { content: "reply one", parent: top.id })).body.comment;
        await k.add(cara, id, { content: "reply two", parent: top.id });
        expect((await k.remove(cara, first.id)).status).toBe(204);
        expect((await k.list(bob, id)).body.comments.map((c) => c.content)).toEqual(["First comment", "reply two"]);
        expect((await k.remove(bob, top.id)).status).toBe(204);
        expect((await k.list(bob, id)).body.comments).toEqual([]);
        expect(await k.model().countDocuments()).toBe(0);
      });
    });
  }

  it("is told to the right person by phone and bell wording is in the notification list", async () => {
    const owner = await signup(app, "owner");
    const bob = await signup(app, "bobby");
    const cara = await signup(app, "carla");
    const id = await kinds.post.make(owner);
    const top = (await kinds.post.add(bob, id, { content: "hello" })).body.comment;
    await kinds.post.add(cara, id, { content: "hi", parent: top.id });
    const list = (await bob.agent.get("/api/notifications")).body.notifications.find((n) => n.type === "reply");
    expect(list.actor.username).toBe("carla");
    expect(list.payload.url).toMatch(/^\/posts\/.*\?comment=/);
  });
});
