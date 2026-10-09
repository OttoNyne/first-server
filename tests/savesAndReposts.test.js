import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.115.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("saving and sharing posts", () => {
  let app, Save, Post, Notification, User;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Save } = await import("../models/Save.js"));
    ({ Post } = await import("../models/Post.js"));
    ({ Notification } = await import("../models/Notification.js"));
    ({ User } = await import("../models/User.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const post = async (who, content) => (await who.agent.post("/api/posts").send({ content })).body.post;
  const piece = async (who, caption = "A piece", n = 1) => (await who.agent.post("/api/media").send({ type: "image", url: `https://img.example.com/${who.user.username}-${n}.png`, caption })).body.mediaItem;
  const feed = async (who) => (await who.agent.get("/api/posts/feed")).body.posts;

  describe("saving", () => {
    it("needs a sign-in", async () => {
      expect((await request(app).put("/api/saves/posts/abc")).status).toBe(401);
      expect((await request(app).get("/api/saves")).status).toBe(401);
    });
    it("saves a post and a piece, shows them as saved wherever they are listed, and takes them out again", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      const p = await post(alice, "A post to keep");
      const m = await piece(alice);
      expect((await bob.agent.put(`/api/saves/posts/${p.id}`)).status).toBe(201);
      expect((await bob.agent.put(`/api/saves/pieces/${m.id}`)).status).toBe(201);
      expect((await feed(bob))[0].saved).toBe(true);
      expect((await alice.agent.get("/api/posts/feed")).body.posts[0].saved).toBe(false);
      expect((await bob.agent.get("/api/media/user/alice")).body.media[0].saved).toBe(true);
      expect((await bob.agent.get("/api/saves?type=posts")).body.posts.map((x) => x.content)).toEqual(["A post to keep"]);
      expect((await bob.agent.get("/api/saves?type=pieces")).body.pieces[0].item.id).toBe(m.id);
      expect((await bob.agent.delete(`/api/saves/posts/${p.id}`)).status).toBe(204);
      expect((await bob.agent.get("/api/saves?type=posts")).body.posts).toEqual([]);
      expect((await feed(bob))[0].saved).toBe(false);
    });
    it("is the same when done twice, and removing something not saved is fine", async () => {
      const alice = await signup(app, "alice");
      const p = await post(alice, "x");
      const bob = await signup(app, "bobby");
      expect((await bob.agent.put(`/api/saves/posts/${p.id}`)).status).toBe(201);
      expect((await bob.agent.put(`/api/saves/posts/${p.id}`)).status).toBe(200);
      expect(await Save.countDocuments()).toBe(1);
      expect((await bob.agent.delete(`/api/saves/posts/${p.id}`)).status).toBe(204);
      expect((await bob.agent.delete(`/api/saves/posts/${p.id}`)).status).toBe(204);
      expect((await bob.agent.delete("/api/saves/posts/nonsense")).status).toBe(204);
    });
    it("keeps each person's list to themselves", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      const p = await post(alice, "Shared interest");
      await bob.agent.put(`/api/saves/posts/${p.id}`);
      expect((await cara.agent.get("/api/saves?type=posts")).body.posts).toEqual([]);
      expect((await alice.agent.get("/api/saves?type=posts")).body.posts).toEqual([]);
    });
    it("refuses what isn't visible to you with the answer a missing one gets", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const p = await post(alice, "Private soon");
      const m = await piece(alice);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      for (const [kind, id] of [["posts", p.id], ["pieces", m.id], ["posts", "nonsense"], ["pieces", "0123456789abcdef01234567"]]) {
        const res = await bob.agent.put(`/api/saves/${kind}/${id}`);
        expect(res.status, `${kind} ${id}`).toBe(404);
      }
      expect(await Save.countDocuments()).toBe(0);
    });
    it("drops an item from the list while its owner is private, suspended or blocked, and brings it back when that ends", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const p = await post(alice, "Saved for later");
      await bob.agent.put(`/api/saves/posts/${p.id}`);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await bob.agent.get("/api/saves?type=posts")).body.posts).toEqual([]);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: false });
      expect((await bob.agent.get("/api/saves?type=posts")).body.posts).toHaveLength(1);
      await User.updateOne({ username: "alice" }, { suspendedAt: new Date() });
      expect((await bob.agent.get("/api/saves?type=posts")).body.posts).toEqual([]);
      await User.updateOne({ username: "alice" }, { suspendedAt: null });
      await bob.agent.post("/api/users/alice/block");
      expect((await bob.agent.get("/api/saves?type=posts")).body.posts).toEqual([]);
    });
    it("pages the list, most recently saved first", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const ids = [];
      for (let i = 0; i < 22; i++) ids.push((await Post.create({ author: alice.user.id, content: `Post ${i}` }))._id);
      for (const id of ids) await Save.create({ user: bob.user.id, targetType: "post", target: id });
      const first = (await bob.agent.get("/api/saves?type=posts")).body;
      expect(first.posts).toHaveLength(20);
      expect(first.posts[0].content).toBe("Post 21");
      expect(first.hasMore).toBe(true);
      const second = (await bob.agent.get(`/api/saves?type=posts&before=${first.next}`)).body;
      expect(second.posts.map((x) => x.content)).toEqual(["Post 1", "Post 0"]);
      expect(second.hasMore).toBe(false);
    });
    it("stops at the most one person can save", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const p = await post(alice, "one more");
      const { MAX_SAVED } = await import("../routes/saves.routes.js");
      const mongoose = (await import("mongoose")).default;
      await Save.insertMany(Array.from({ length: MAX_SAVED }, () => ({ user: bob.user.id, targetType: "post", target: new mongoose.Types.ObjectId() })));
      const res = await bob.agent.put(`/api/saves/posts/${p.id}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/up to 2000/);
    });
    it("goes when the post or piece does, and with the account, and is in the data download", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const p = await post(alice, "temporary");
      const m = await piece(alice);
      await bob.agent.put(`/api/saves/posts/${p.id}`);
      await bob.agent.put(`/api/saves/pieces/${m.id}`);
      const download = JSON.parse((await bob.agent.post("/api/profiles/me/export").send({ password: "password123" })).text);
      expect(download.saved).toEqual({ posts: [p.id], pieces: [m.id] });
      await alice.agent.delete(`/api/posts/${p.id}`);
      await alice.agent.delete(`/api/media/${m.id}`);
      expect(await Save.countDocuments()).toBe(0);
      const q = await post(alice, "another");
      await bob.agent.put(`/api/saves/posts/${q.id}`);
      expect((await bob.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await Save.countDocuments()).toBe(0);
    });
  });

  describe("sharing a post to your feed", () => {
    it("shares it, with or without words, shows the original inside, and tells the author", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      const original = await post(alice, "Original words #art");
      await befriend(bob, cara);
      const res = await bob.agent.post(`/api/posts/${original.id}/repost`).send({ content: "Look at this" });
      expect(res.status).toBe(201);
      expect(res.body.post).toMatchObject({ isRepost: true, content: "Look at this", repost: { available: true, id: original.id, content: "Original words #art" } });
      expect(res.body.post.repost.author.username).toBe("alice");
      const seenByFriend = (await feed(cara)).find((p) => p.isRepost);
      expect(seenByFriend.repost.content).toBe("Original words #art");
      const note = await Notification.findOne({ recipient: alice.user.id, type: "repost" }).lean();
      expect(note.payload).toMatchObject({ actorId: bob.user.id, postId: res.body.post.id });
      const silent = await signup(app, "dana");
      const original2 = await post(alice, "Another one");
      const bare = await silent.agent.post(`/api/posts/${original2.id}/repost`).send({});
      expect(bare.status).toBe(201);
      expect(bare.body.post.content).toBe("");
    });
    it("shares the original when a repost is shared, and only once per person", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      const original = await post(alice, "Root");
      const first = await bob.agent.post(`/api/posts/${original.id}/repost`).send({});
      const second = await cara.agent.post(`/api/posts/${first.body.post.id}/repost`).send({ content: "via bob" });
      expect(second.status).toBe(201);
      expect(second.body.post.repost.id).toBe(original.id);
      const again = await bob.agent.post(`/api/posts/${original.id}/repost`).send({});
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("You've already shared this post");
      expect(await Post.countDocuments({ isRepost: true })).toBe(2);
    });
    it("refuses your own post, a private profile's post, a blocked person's, and one that can't be found", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const mine = await post(bob, "mine");
      const own = await bob.agent.post(`/api/posts/${mine.id}/repost`).send({});
      expect(own.status).toBe(400);
      expect(own.body.error).toBe("You can't share your own post");
      const p = await post(alice, "hers");
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await bob.agent.post(`/api/posts/${p.id}/repost`).send({})).status).toBe(404);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: false });
      await bob.agent.post("/api/users/alice/block");
      expect((await bob.agent.post(`/api/posts/${p.id}/repost`).send({})).status).toBe(404);
      for (const id of ["nonsense", "0123456789abcdef01234567"]) expect((await bob.agent.post(`/api/posts/${id}/repost`).send({})).status).toBe(404);
      expect(await Post.countDocuments({ isRepost: true })).toBe(0);
    });
    it("checks the words like any post, and refuses a share of a friends-only view the sharer can't open", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const p = await post(alice, "x");
      expect((await bob.agent.post(`/api/posts/${p.id}/repost`).send({ content: 5 })).status).toBe(400);
      expect((await bob.agent.post(`/api/posts/${p.id}/repost`).send({ content: "a".repeat(5001) })).status).toBe(400);
      expect(await Post.countDocuments({ isRepost: true })).toBe(0);
    });
    it("shows 'unavailable' instead of the original when it is deleted, goes private, is suspended or is blocked", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      await befriend(bob, cara);
      const original = await post(alice, "Secret later");
      await bob.agent.post(`/api/posts/${original.id}/repost`).send({ content: "sharing" });
      const view = async () => (await feed(cara)).find((p) => p.isRepost);
      expect((await view()).repost.available).toBe(true);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      const hidden = await view();
      expect(hidden.repost).toEqual({ available: false });
      expect(JSON.stringify(hidden)).not.toContain("Secret later");
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: false });
      await User.updateOne({ username: "alice" }, { suspendedAt: new Date() });
      expect((await view()).repost).toEqual({ available: false });
      await User.updateOne({ username: "alice" }, { suspendedAt: null });
      await cara.agent.post("/api/users/alice/block");
      expect((await view()).repost).toEqual({ available: false });
      await cara.agent.delete("/api/users/alice/block");
      await alice.agent.delete(`/api/posts/${original.id}`);
      expect((await view()).repost).toEqual({ available: false });
    });
    it("lets the sharer change or clear their words, and take the share off, which removes the notice", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const original = await post(alice, "Root");
      const shared = (await bob.agent.post(`/api/posts/${original.id}/repost`).send({ content: "first" })).body.post;
      expect((await bob.agent.patch(`/api/posts/${shared.id}`).send({ content: "second #tag" })).body.post.content).toBe("second #tag");
      expect((await Post.findById(shared.id)).tags).toEqual(["tag"]);
      expect((await bob.agent.patch(`/api/posts/${shared.id}`).send({ content: "" })).body.post.content).toBe("");
      const plain = await bob.agent.patch(`/api/posts/${original.id}`).send({ content: "" });
      expect(plain.status).toBe(403);
      expect((await bob.agent.delete(`/api/posts/${shared.id}`)).status).toBe(204);
      expect(await Notification.countDocuments({ type: "repost" })).toBe(0);
      expect((await Post.findById(original.id)).content).toBe("Root");
    });
    it("mentions in the sharer's words notify, like any post", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      const original = await post(alice, "Root");
      const res = await bob.agent.post(`/api/posts/${original.id}/repost`).send({ content: "thought of @carla" });
      expect(res.status).toBe(201);
      expect(await Notification.countDocuments({ recipient: cara.user.id, type: "mention" })).toBe(1);
    });
    it("appears on the sharer's profile and on Explore as a share", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const original = await post(alice, "Root");
      await bob.agent.post(`/api/posts/${original.id}/repost`).send({ content: "see #topic" });
      const profile = (await alice.agent.get("/api/posts/user/bobby")).body.posts;
      expect(profile[0].isRepost).toBe(true);
      expect(profile[0].repost.content).toBe("Root");
      const explored = (await request(app).get("/api/explore?tag=topic")).body.posts;
      expect(explored[0]).toMatchObject({ isRepost: true, repost: { available: true } });
    });
  });
});
