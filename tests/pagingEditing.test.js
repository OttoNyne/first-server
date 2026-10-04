import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${150 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("paging, and changing what you wrote", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      Post: (await import("../models/Post.js")).Post,
      Comment: (await import("../models/Comment.js")).Comment,
      ProfileComment: (await import("../models/ProfileComment.js")).ProfileComment,
      Bulletin: (await import("../models/Bulletin.js")).Bulletin,
      GroupTopic: (await import("../models/GroupTopic.js")).GroupTopic,
      GroupReply: (await import("../models/GroupReply.js")).GroupReply,
      Message: (await import("../models/Message.js")).Message,
      MediaItem: (await import("../models/MediaItem.js")).MediaItem,
      Notification: (await import("../models/Notification.js")).Notification,
      Group: (await import("../models/Group.js")).Group,
      GroupMembership: (await import("../models/GroupMembership.js")).GroupMembership,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  // ---------------------------------------------------------------- what people can write
  describe("what can be written", () => {
    it("posts, comments and testimonials must be real text, cleaned, and not too long", async () => {
      const alice = await signup(app, "alice");
      const post = await alice.agent.post("/api/posts").send({ content: "  Hello​   world\r\n\r\n\r\n\r\nBye  " });
      expect(post.status).toBe(201);
      expect(post.body.post.content).toBe("Hello   world\n\nBye"); // hidden characters go, blank lines are tidied, spaces inside a line stay
      for (const content of ["", "   ", null, 5, ["x"], { a: 1 }, "x".repeat(5001)]) expect((await alice.agent.post("/api/posts").send({ content })).status, JSON.stringify(content)?.slice(0, 20)).toBe(400);
      expect((await alice.agent.post("/api/posts").send({ content: "x".repeat(5000) })).status).toBe(201);

      const id = post.body.post.id;
      const c = await alice.agent.post(`/api/posts/${id}/comments`).send({ content: " nice​ " });
      expect(c.body.comment.content).toBe("nice");
      for (const content of ["", null, 7, "x".repeat(1001)]) expect((await alice.agent.post(`/api/posts/${id}/comments`).send({ content })).status, String(content)?.slice(0, 10)).toBe(400);

      const t = await alice.agent.post("/api/profiles/alice/comments").send({ content: "  great​ work " });
      expect(t.body.comment.content).toBe("great work");
      for (const content of ["", null, 7, "x".repeat(1001)]) expect((await alice.agent.post("/api/profiles/alice/comments").send({ content })).status, String(content)?.slice(0, 10)).toBe(400);
    });

    it("limits how fast someone can post, comment or write testimonials", async () => {
      const alice = await signup(app, "alice");
      for (let i = 0; i < 20; i++) expect((await alice.agent.post("/api/posts").send({ content: `p${i}` })).status).toBe(201);
      const limited = await alice.agent.post("/api/posts").send({ content: "one too many" });
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeTruthy();

      const bob = await signup(app, "bobby");
      const post = await M.Post.create({ author: bob.user.id, content: "x" });
      for (let i = 0; i < 40; i++) expect((await bob.agent.post(`/api/posts/${post._id}/comments`).send({ content: `c${i}` })).status).toBe(201);
      expect((await bob.agent.post(`/api/posts/${post._id}/comments`).send({ content: "no" })).status).toBe(429);

      const cara = await signup(app, "carah");
      for (let i = 0; i < 20; i++) expect((await cara.agent.post("/api/profiles/alice/comments").send({ content: `t${i}` })).status).toBe(201);
      expect((await cara.agent.post("/api/profiles/alice/comments").send({ content: "no" })).status).toBe(429);
    });
  });

  // ---------------------------------------------------------------- editing
  describe("editing a post", () => {
    it("lets the author change the words, marks it edited, and leaves the picture alone", async () => {
      const alice = await signup(app, "alice");
      const made = await alice.agent.post("/api/posts").send({ content: "First", imageUrl: "https://images.example.com/a.jpg", imageZoom: 2 });
      expect(made.body.post.editedAt).toBeNull();
      const res = await alice.agent.patch(`/api/posts/${made.body.post.id}`).send({ content: "  Second​  ", imageUrl: "https://evil.example/x.jpg", author: "x" });
      expect(res.status).toBe(200);
      expect(res.body.post).toMatchObject({ content: "Second", imageUrl: "https://images.example.com/a.jpg", imageZoom: 2 });
      expect(res.body.post.editedAt).toBeTruthy();
      expect((await alice.agent.get(`/api/posts/${made.body.post.id}`)).body.post.editedAt).toBeTruthy();
    });

    it("doesn't mark it edited when nothing changed", async () => {
      const alice = await signup(app, "alice");
      const made = await alice.agent.post("/api/posts").send({ content: "Same" });
      const res = await alice.agent.patch(`/api/posts/${made.body.post.id}`).send({ content: "Same" });
      expect(res.status).toBe(200);
      expect(res.body.post.editedAt).toBeNull();
    });

    it("is for the author only, checks the text, and answers sensibly for ids that aren't there", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const made = await alice.agent.post("/api/posts").send({ content: "Mine" });
      const url = `/api/posts/${made.body.post.id}`;
      expect((await bob.agent.patch(url).send({ content: "Hijack" })).status).toBe(403);
      expect((await M.Post.findById(made.body.post.id)).content).toBe("Mine");
      for (const content of ["", "  ", null, 3, "x".repeat(5001)]) expect((await alice.agent.patch(url).send({ content })).status).toBe(400);
      expect((await alice.agent.patch("/api/posts/not-an-id").send({ content: "x" })).status).toBe(404);
      expect((await alice.agent.patch("/api/posts/5f1d7f3b8f1d7f3b8f1d7f3b").send({ content: "x" })).status).toBe(404);
      expect((await request(app).patch(url).send({ content: "x" })).status).toBe(401);
    });

    it("limits how many changes someone can make an hour, across everything", async () => {
      const alice = await signup(app, "alice");
      const made = await alice.agent.post("/api/posts").send({ content: "Start" });
      const url = `/api/posts/${made.body.post.id}`;
      for (let i = 0; i < 60; i++) expect((await alice.agent.patch(url).send({ content: `v${i}` })).status).toBe(200);
      const limited = await alice.agent.patch(url).send({ content: "too many" });
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeTruthy();
    });
  });

  describe("editing comments and testimonials", () => {
    it("lets only a comment's author change it; the post's owner can still delete it but not rewrite it", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const post = await M.Post.create({ author: alice.user.id, content: "x" });
      const c = (await bob.agent.post(`/api/posts/${post._id}/comments`).send({ content: "typo" })).body.comment;
      expect((await alice.agent.patch(`/api/comments/${c.id}`).send({ content: "rewritten" })).status).toBe(403);
      const res = await bob.agent.patch(`/api/comments/${c.id}`).send({ content: "fixed" });
      expect(res.status).toBe(200);
      expect(res.body.comment).toMatchObject({ content: "fixed" });
      expect(res.body.comment.editedAt).toBeTruthy();
      expect((await bob.agent.patch(`/api/comments/${c.id}`).send({ content: "" })).status).toBe(400);
      expect((await bob.agent.patch("/api/comments/not-an-id").send({ content: "x" })).status).toBe(404);
      expect((await alice.agent.delete(`/api/comments/${c.id}`)).status).toBe(204);
    });

    it("lets only a testimonial's writer change it, not the profile's owner", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const t = (await bob.agent.post("/api/profiles/alice/comments").send({ content: "grate work" })).body.comment;
      expect((await alice.agent.patch(`/api/profiles/comments/${t.id}`).send({ content: "rewritten" })).status).toBe(404);
      const res = await bob.agent.patch(`/api/profiles/comments/${t.id}`).send({ content: "great work" });
      expect(res.status).toBe(200);
      expect(res.body.comment.editedAt).toBeTruthy();
      expect((await M.ProfileComment.findById(t.id)).content).toBe("great work");
      expect((await bob.agent.patch(`/api/profiles/comments/${t.id}`).send({ content: "x".repeat(1001) })).status).toBe(400);
      expect((await bob.agent.patch("/api/profiles/comments/not-an-id").send({ content: "x" })).status).toBe(404);
    });
  });

  describe("editing a bulletin", () => {
    it("changes the title, the text or both, keeps the ten days, and marks it edited", async () => {
      const alice = await signup(app, "alice");
      const made = (await alice.agent.post("/api/bulletins").send({ title: "Show", body: "Friday" })).body.bulletin;
      const url = `/api/bulletins/${made.id}`;
      const a = await alice.agent.patch(url).send({ title: "  Big   show " });
      expect(a.body.bulletin).toMatchObject({ title: "Big show", body: "Friday", expiresAt: made.expiresAt });
      expect(a.body.bulletin.editedAt).toBeTruthy();
      const b = await alice.agent.patch(url).send({ body: "Saturday" });
      expect(b.body.bulletin).toMatchObject({ title: "Big show", body: "Saturday" });
      expect((await alice.agent.patch(url).send({ title: "", body: "x" })).status).toBe(400);
      expect((await alice.agent.patch(url).send({ body: "x".repeat(501) })).status).toBe(400);
    });

    it("is for the author only, and not for one that has expired", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      const made = (await alice.agent.post("/api/bulletins").send({ title: "Show", body: "Friday" })).body.bulletin;
      expect((await bob.agent.patch(`/api/bulletins/${made.id}`).send({ title: "Hijack" })).status).toBe(404);
      expect((await alice.agent.patch("/api/bulletins/not-an-id").send({ title: "x" })).status).toBe(404);
      await M.Bulletin.updateOne({ _id: made.id }, { $set: { expireAt: new Date(Date.now() - 1000) } });
      expect((await alice.agent.patch(`/api/bulletins/${made.id}`).send({ title: "Late" })).status).toBe(404);
    });

    it("shows friends the change and the mark", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      const made = (await alice.agent.post("/api/bulletins").send({ title: "Show", body: "Friday" })).body.bulletin;
      await alice.agent.patch(`/api/bulletins/${made.id}`).send({ body: "Saturday" });
      const seen = (await bob.agent.get("/api/bulletins")).body.bulletins[0];
      expect(seen).toMatchObject({ body: "Saturday" });
      expect(seen.editedAt).toBeTruthy();
    });
  });

  describe("editing on a group's board", () => {
    async function board() {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const gid = (await alice.agent.post("/api/groups").send({ name: "Potters" })).body.group.id;
      await bob.agent.post(`/api/groups/${gid}/join`);
      const topic = (await bob.agent.post(`/api/groups/${gid}/topics`).send({ title: "Kiln", body: "Which one?" })).body.topic;
      const reply = (await alice.agent.post(`/api/groups/${gid}/topics/${topic.id}/replies`).send({ body: "This one" })).body.reply;
      return { alice, bob, gid, topic, reply };
    }

    it("lets an author change a topic, partly or wholly, and marks it", async () => {
      const { bob, gid, topic } = await board();
      const url = `/api/groups/${gid}/topics/${topic.id}`;
      const a = await bob.agent.patch(url).send({ title: "Kiln advice" });
      expect(a.body.topic).toMatchObject({ title: "Kiln advice", body: "Which one?" });
      expect(a.body.topic.editedAt).toBeTruthy();
      expect((await bob.agent.patch(url).send({ body: "Which kiln, electric?" })).body.topic.body).toBe("Which kiln, electric?");
      expect((await bob.agent.patch(url).send({ title: "" })).status).toBe(400);
      expect((await bob.agent.patch(url).send({ body: "x".repeat(2001) })).status).toBe(400);
    });

    it("lets an author change a reply, and marks it", async () => {
      const { alice, gid, topic, reply } = await board();
      const url = `/api/groups/${gid}/topics/${topic.id}/replies/${reply.id}`;
      const res = await alice.agent.patch(url).send({ body: " This one, with a lid " });
      expect(res.body.reply).toMatchObject({ body: "This one, with a lid" });
      expect(res.body.reply.editedAt).toBeTruthy();
      expect((await alice.agent.patch(url).send({ body: "" })).status).toBe(400);
      expect((await alice.agent.patch(url).send({ body: "x".repeat(1001) })).status).toBe(400);
    });

    it("never lets an admin or anyone else rewrite someone else's words, and keeps it to members", async () => {
      const { alice, bob, gid, topic, reply } = await board();
      // alice is the group's admin: she moderates by removing, not by editing
      expect((await alice.agent.patch(`/api/groups/${gid}/topics/${topic.id}`).send({ title: "Hijack" })).status).toBe(404);
      expect((await bob.agent.patch(`/api/groups/${gid}/topics/${topic.id}/replies/${reply.id}`).send({ body: "Hijack" })).status).toBe(404);
      const outsider = await signup(app, "outsider");
      expect((await outsider.agent.patch(`/api/groups/${gid}/topics/${topic.id}`).send({ title: "x" })).status).toBe(403);
      expect((await M.GroupTopic.findById(topic.id)).title).toBe("Kiln");
      expect((await bob.agent.patch(`/api/groups/${gid}/topics/not-an-id`).send({ title: "x" })).status).toBe(404);
    });
  });

  describe("editing a direct message", () => {
    async function pair() {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      const sent = (await alice.agent.post("/api/messages/with/bobby").send({ body: "Se you at 7" })).body.message;
      return { alice, bob, sent };
    }

    it("lets the sender fix it within fifteen minutes, and both people see it marked", async () => {
      const { alice, bob, sent } = await pair();
      const res = await alice.agent.patch(`/api/messages/${sent.id}`).send({ body: "See you at 7" });
      expect(res.status).toBe(200);
      expect(res.body.message).toMatchObject({ body: "See you at 7", mine: true });
      expect(res.body.message.editedAt).toBeTruthy();
      const seen = (await bob.agent.get("/api/messages/with/alice")).body.messages[0];
      expect(seen).toMatchObject({ body: "See you at 7", mine: false });
      expect(seen.editedAt).toBeTruthy();
    });

    it("refuses once the fifteen minutes are over, and says why", async () => {
      const { alice, sent } = await pair();
      await M.Message.collection.updateOne({ _id: new mongoose.Types.ObjectId(sent.id) }, { $set: { createdAt: new Date(Date.now() - 16 * 60_000) } }); // (createdAt can't be changed through the model)
      const res = await alice.agent.patch(`/api/messages/${sent.id}`).send({ body: "Too late" });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("edit_window_over");
      expect((await M.Message.findById(sent.id)).body).toBe("Se you at 7");
      await M.Message.collection.updateOne({ _id: new mongoose.Types.ObjectId(sent.id) }, { $set: { createdAt: new Date(Date.now() - 14 * 60_000) } });
      expect((await alice.agent.patch(`/api/messages/${sent.id}`).send({ body: "Just in time" })).status).toBe(200);
    });

    it("is for the sender only, checks the text, and doesn't resend or re-notify", async () => {
      const { alice, bob, sent } = await pair();
      expect((await bob.agent.patch(`/api/messages/${sent.id}`).send({ body: "Hijack" })).status).toBe(404);
      expect((await alice.agent.patch(`/api/messages/${sent.id}`).send({ body: "  " })).status).toBe(400);
      expect((await alice.agent.patch(`/api/messages/${sent.id}`).send({ body: "x".repeat(2001) })).status).toBe(400);
      expect((await alice.agent.patch("/api/messages/not-an-id").send({ body: "x" })).status).toBe(404);
      const before = await M.Notification.countDocuments({ type: "message" });
      await alice.agent.patch(`/api/messages/${sent.id}`).send({ body: "See you at 7" });
      expect(await M.Notification.countDocuments({ type: "message" })).toBe(before);
      expect(await M.Message.countDocuments()).toBe(1);
    });
  });

  // ---------------------------------------------------------------- paging
  describe("the feed", () => {
    it("shows twenty at a time, newest first, and 'before' asks for older ones without repeats", async () => {
      const alice = await signup(app, "alice");
      const posts = [];
      for (let i = 0; i < 25; i++) posts.push(await M.Post.create({ author: alice.user.id, content: `post ${i}` }));
      const first = (await alice.agent.get("/api/posts/feed")).body;
      expect(first.posts).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.posts[0].content).toBe("post 24");
      expect(first.posts[19].content).toBe("post 5");
      const second = (await alice.agent.get(`/api/posts/feed?before=${first.posts[19].id}`)).body;
      expect(second.posts.map((p) => p.content)).toEqual(["post 4", "post 3", "post 2", "post 1", "post 0"]);
      expect(second.hasMore).toBe(false);
    });

    it("includes friends' posts across pages, and ignores a cursor that isn't an id", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      for (let i = 0; i < 12; i++) await M.Post.create({ author: alice.user.id, content: `a${i}` });
      for (let i = 0; i < 12; i++) await M.Post.create({ author: bob.user.id, content: `b${i}` });
      const first = (await alice.agent.get("/api/posts/feed?before=garbage")).body;
      expect(first.posts).toHaveLength(20);
      const second = (await alice.agent.get(`/api/posts/feed?before=${first.posts[19].id}`)).body;
      expect(second.posts).toHaveLength(4);
      expect(new Set([...first.posts, ...second.posts].map((p) => p.id)).size).toBe(24);
    });

    it("pages a person's own posts the same way", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      for (let i = 0; i < 22; i++) await M.Post.create({ author: alice.user.id, content: `p${i}` });
      const first = (await bob.agent.get("/api/posts/user/alice")).body;
      expect(first.posts).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect((await bob.agent.get(`/api/posts/user/alice?before=${first.posts[19].id}`)).body.posts).toHaveLength(2);
    });
  });

  describe("comments", () => {
    it("on a post: twenty at a time, oldest first, 'after' asks for the next ones", async () => {
      const alice = await signup(app, "alice");
      const post = await M.Post.create({ author: alice.user.id, content: "x" });
      for (let i = 0; i < 23; i++) await M.Comment.create({ post: post._id, author: alice.user.id, content: `c${i}` });
      const first = (await alice.agent.get(`/api/posts/${post._id}/comments`)).body;
      expect(first.comments).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.comments[0].content).toBe("c0");
      const second = (await alice.agent.get(`/api/posts/${post._id}/comments?after=${first.comments[19].id}`)).body;
      expect(second.comments.map((c) => c.content)).toEqual(["c20", "c21", "c22"]);
      expect(second.hasMore).toBe(false);
    });

    it("testimonials: newest first, twenty at a time, 'before' asks for older ones", async () => {
      const alice = await signup(app, "alice");
      for (let i = 0; i < 22; i++) await M.ProfileComment.create({ profileOwner: alice.user.id, author: alice.user.id, content: `t${i}` });
      const first = (await alice.agent.get("/api/profiles/alice/comments")).body;
      expect(first.comments).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.comments[0].content).toBe("t21");
      const second = (await alice.agent.get(`/api/profiles/alice/comments?before=${first.comments[19].id}`)).body;
      expect(second.comments.map((c) => c.content)).toEqual(["t1", "t0"]);
      expect(second.hasMore).toBe(false);
    });
  });

  describe("notifications", () => {
    it("shows the newest thirty, with 'before' for older ones", async () => {
      const alice = await signup(app, "alice");
      await M.Notification.insertMany(Array.from({ length: 35 }, (_, i) => ({ recipient: alice.user.id, type: "friend_accept", payload: { n: i } })));
      const first = (await alice.agent.get("/api/notifications")).body;
      expect(first.notifications).toHaveLength(30);
      expect(first.notifications[0].payload.n).toBe(34);
      const second = (await alice.agent.get(`/api/notifications?before=${first.notifications[29].id}`)).body;
      expect(second.notifications.map((n) => n.payload.n)).toEqual([4, 3, 2, 1, 0]);
    });

    it("only ever shows a person their own", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await M.Notification.create({ recipient: alice.user.id, type: "friend_accept", payload: {} });
      const mine = (await alice.agent.get("/api/notifications")).body.notifications[0];
      expect((await bob.agent.get(`/api/notifications?before=${mine.id}x`)).body.notifications).toEqual([]);
      expect((await bob.agent.get("/api/notifications")).body.notifications).toEqual([]);
    });
  });

  describe("groups and members", () => {
    it("lists twenty groups a page, newest first, searchable, and tells you your own role in each", async () => {
      const alice = await signup(app, "alice");
      for (let i = 0; i < 22; i++) await alice.agent.post("/api/groups").send({ name: `Group ${i}` });
      const bob = await signup(app, "bobby");
      const first = (await bob.agent.get("/api/groups")).body;
      expect(first.groups).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.groups[0].name).toBe("Group 21");
      expect(first.groups.every((g) => g.myRole === null)).toBe(true);
      const second = (await bob.agent.get("/api/groups?page=2")).body;
      expect(second.groups).toHaveLength(2);
      expect(second.hasMore).toBe(false);
      expect((await bob.agent.get("/api/groups?search=Group 7")).body.groups.map((g) => g.name)).toEqual(["Group 7"]);
      const mine = (await alice.agent.get("/api/groups")).body.groups[0];
      expect(mine).toMatchObject({ isMember: true, myRole: "admin" });
      await bob.agent.post(`/api/groups/${mine.id}/join`);
      expect((await bob.agent.get(`/api/groups/${mine.id}`)).body.group).toMatchObject({ isMember: true, myRole: "member" });
    });

    it("lists members fifty a page, in the order they joined", async () => {
      const alice = await signup(app, "alice");
      const group = (await alice.agent.post("/api/groups").send({ name: "Big" })).body.group;
      const { User } = await import("../models/User.js");
      const users = await User.insertMany(Array.from({ length: 52 }, (_, i) => ({ email: `m${i}@example.com`, username: `mm${i}`, passwordHash: "x", displayName: `M${i}` })));
      await M.GroupMembership.insertMany(users.map((u, i) => ({ group: group.id, user: u._id, role: "member", joinedAt: new Date(Date.now() + (i + 1) * 1000) })));
      const first = (await alice.agent.get(`/api/groups/${group.id}/members`)).body;
      expect(first.members).toHaveLength(50);
      expect(first.hasMore).toBe(true);
      expect(first.members[0].role).toBe("admin"); // the founder, who joined first
      const second = (await alice.agent.get(`/api/groups/${group.id}/members?page=2`)).body;
      expect(second.members).toHaveLength(3);
      expect(second.hasMore).toBe(false);
    });
  });

  describe("the portfolio", () => {
    it("holds at most 200 pieces", async () => {
      const alice = await signup(app, "alice");
      await M.MediaItem.insertMany(Array.from({ length: 200 }, (_, i) => ({ owner: alice.user.id, url: `https://images.example.com/${i}.jpg`, type: "image" })));
      const res = await alice.agent.post("/api/media").send({ type: "image", url: "https://images.example.com/one-more.jpg" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/portfolio is full/);
      await M.MediaItem.deleteOne({ owner: alice.user.id });
      expect((await alice.agent.post("/api/media").send({ type: "image", url: "https://images.example.com/fits-now.jpg" })).status).toBe(201);
    });

    it("is counted per person", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await M.MediaItem.insertMany(Array.from({ length: 200 }, (_, i) => ({ owner: alice.user.id, url: `https://images.example.com/${i}.jpg`, type: "image" })));
      expect((await bob.agent.post("/api/media").send({ type: "image", url: "https://images.example.com/bobs.jpg" })).status).toBe(201);
    });
  });
});
