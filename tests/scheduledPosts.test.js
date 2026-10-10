import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.127.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const inMinutes = (n) => new Date(Date.now() + n * MINUTE).toISOString();

describe("scheduled posts", () => {
  let app, M, service;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    service = await import("../services/scheduledPosts.js");
    M = {
      User: (await import("../models/User.js")).User,
      Post: (await import("../models/Post.js")).Post,
      ScheduledPost: (await import("../models/ScheduledPost.js")).ScheduledPost,
      Notification: (await import("../models/Notification.js")).Notification,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const schedule = (who, body = {}) => who.agent.post("/api/scheduled-posts").send({ content: "See you at the show #gig", publishAt: inMinutes(30), ...body });
  const list = async (who) => (await who.agent.get("/api/scheduled-posts")).body.posts;
  const feedOf = async (who) => (await who.agent.get("/api/posts/feed")).body.posts;
  const later = (minutes) => new Date(Date.now() + minutes * MINUTE);

  describe("scheduling", () => {
    it("keeps a post of its own that nobody else can read, and is not on the feed, a profile, Explore or search before its time", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bob");
      await bob.agent.post(`/api/follows/${ann.user.username}`);
      const made = await schedule(ann, { content: "A secret plan #later" });
      expect(made.status).toBe(201);
      expect(made.body.post).toMatchObject({ content: "A secret plan #later", failed: false });
      expect(await M.Post.countDocuments()).toBe(0);
      expect((await list(ann)).map((p) => p.content)).toEqual(["A secret plan #later"]);
      expect(await list(bob)).toEqual([]);
      expect(await feedOf(bob)).toEqual([]);
      expect((await bob.agent.get(`/api/posts/user/${ann.user.username}`)).body.posts).toEqual([]);
      expect((await request(app).get("/api/explore?tag=later")).body.posts ?? []).toEqual([]);
      // someone else can't touch it either, and the answer is the one for a missing one
      const id = made.body.post.id;
      expect((await bob.agent.patch(`/api/scheduled-posts/${id}`).send({ content: "mine now" })).status).toBe(404);
      expect((await bob.agent.post(`/api/scheduled-posts/${id}/publish`)).status).toBe(404);
      expect((await bob.agent.delete(`/api/scheduled-posts/${id}`)).status).toBe(404);
    });

    it("needs a signed-in person", async () => {
      expect((await request(app).get("/api/scheduled-posts")).status).toBe(401);
      expect((await request(app).post("/api/scheduled-posts").send({ content: "x", publishAt: inMinutes(30) })).status).toBe(401);
    });

    it("checks the words, the time and the extras the way a post is checked", async () => {
      const ann = await signup(app, "ann");
      expect((await schedule(ann, { content: "   " })).status).toBe(400);
      expect((await schedule(ann, { content: "x".repeat(5001) })).status).toBe(400);
      expect((await schedule(ann, { publishAt: undefined })).status).toBe(400);
      expect((await schedule(ann, { publishAt: "tomorrow" })).status).toBe(400);
      expect((await schedule(ann, { publishAt: inMinutes(-5) })).status).toBe(400);
      expect((await schedule(ann, { publishAt: inMinutes(0.2) })).status).toBe(400);
      expect((await schedule(ann, { publishAt: new Date(Date.now() + 91 * DAY).toISOString() })).status).toBe(400);
      expect((await schedule(ann, { poll: { options: ["Only one"] } })).status).toBe(400);
      expect((await schedule(ann, { imageUrl: "https://img.example.com/a.png", imageAspect: "5:1" })).status).toBe(400);
      expect((await schedule(ann, { imageUrl: "https://img.example.com/a.png", imageAlt: "y".repeat(301) })).status).toBe(400);
      expect(await list(ann)).toEqual([]);
      const ok = await schedule(ann, { imageUrl: "https://img.example.com/a.png", imageAspect: "16:9", imageAlt: "A red door", poll: { options: ["Yes", "No"], days: 3 }, publishAt: new Date(Date.now() + 89 * DAY).toISOString() });
      expect(ok.status).toBe(201);
      expect(ok.body.post).toMatchObject({ imageUrl: "https://img.example.com/a.png", imageAspect: "16:9", imageAlt: "A red door", poll: { options: ["Yes", "No"], days: 3 } });
    });

    it("allows twenty at a time, and limits how many are made in a day", async () => {
      const ann = await signup(app, "ann");
      await M.ScheduledPost.insertMany(Array.from({ length: 20 }, (_, i) => ({ author: ann.user.id, content: `n${i}`, publishAt: later(60 + i) })));
      const full = await schedule(ann);
      expect(full.status).toBe(409);
      expect(full.body.error).toMatch(/up to 20/);
      const bob = await signup(app, "bob");
      await M.RateLimitHit.insertMany(Array.from({ length: 30 }, () => ({ key: `scheduled-post:${bob.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
      expect((await schedule(bob)).status).toBe(429);
    });

    it("lists them in the order they will go out", async () => {
      const ann = await signup(app, "ann");
      await schedule(ann, { content: "third", publishAt: inMinutes(300) });
      await schedule(ann, { content: "first", publishAt: inMinutes(10) });
      await schedule(ann, { content: "second", publishAt: inMinutes(60) });
      expect((await list(ann)).map((p) => p.content)).toEqual(["first", "second", "third"]);
    });
  });

  describe("changing and taking back", () => {
    it("changes the words, the time and the picture's description, but not other people's", async () => {
      const ann = await signup(app, "ann");
      const made = (await schedule(ann, { imageUrl: "https://img.example.com/a.png", imageAlt: "old" })).body.post;
      const changed = await ann.agent.patch(`/api/scheduled-posts/${made.id}`).send({ content: "New words", imageAlt: "A red door", publishAt: inMinutes(120) });
      expect(changed.status).toBe(200);
      expect(changed.body.post).toMatchObject({ content: "New words", imageAlt: "A red door" });
      expect(new Date(changed.body.post.publishAt).getTime()).toBeGreaterThan(Date.now() + 100 * MINUTE);
      expect((await ann.agent.patch(`/api/scheduled-posts/${made.id}`).send({})).status).toBe(400);
      expect((await ann.agent.patch(`/api/scheduled-posts/${made.id}`).send({ content: "" })).status).toBe(400);
      expect((await ann.agent.patch(`/api/scheduled-posts/${made.id}`).send({ publishAt: inMinutes(0.1) })).status).toBe(400);
      const plain = (await schedule(ann)).body.post;
      expect((await ann.agent.patch(`/api/scheduled-posts/${plain.id}`).send({ imageAlt: "No picture" })).status).toBe(400);
    });

    it("takes one back, with nothing left of it", async () => {
      const ann = await signup(app, "ann");
      const made = (await schedule(ann)).body.post;
      expect((await ann.agent.delete(`/api/scheduled-posts/${made.id}`)).status).toBe(204);
      expect(await list(ann)).toEqual([]);
      expect(await M.ScheduledPost.countDocuments()).toBe(0);
      expect((await ann.agent.delete(`/api/scheduled-posts/${made.id}`)).status).toBe(404);
      expect((await ann.agent.delete("/api/scheduled-posts/nope")).status).toBe(404);
    });
  });

  describe("publishing", () => {
    it("publishes what has come due, as a normal post at the top of the feed, tells its author, and removes the record", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bob");
      await bob.agent.post(`/api/follows/${ann.user.username}`);
      await schedule(ann, { content: "Not yet", publishAt: inMinutes(600) });
      const due = (await schedule(ann, { content: "Going out now #launch", publishAt: inMinutes(5), imageUrl: "https://img.example.com/a.png", imageAlt: "A red door", poll: { options: ["Yes", "No"], days: 1 } })).body.post;
      expect(await service.publishDuePosts(later(4))).toBe(0); // not yet
      expect(await M.Post.countDocuments()).toBe(0);

      expect(await service.publishDuePosts(later(6))).toBe(1);
      const feed = await feedOf(bob);
      expect(feed.map((p) => p.content)).toEqual(["Going out now #launch"]);
      expect(feed[0]).toMatchObject({ imageUrl: "https://img.example.com/a.png", imageAlt: "A red door" });
      expect(feed[0].poll.options.map((o) => o.text)).toEqual(["Yes", "No"]);
      expect((await M.Post.findOne()).tags).toEqual(["launch"]);
      // the poll runs from the moment it was published
      expect(new Date((await M.Post.findOne()).poll.endsAt).getTime()).toBeGreaterThan(later(6).getTime() + 23 * 60 * MINUTE);
      expect((await list(ann)).map((p) => p.content)).toEqual(["Not yet"]); // only the waiting one is left
      expect(await M.ScheduledPost.findById(due.id)).toBeNull();
      const notices = await M.Notification.find({ recipient: ann.user.id, type: "scheduled_post" });
      expect(notices).toHaveLength(1);
      expect(String(notices[0].payload.postId)).toBe(String((await M.Post.findOne())._id));
      expect(notices[0].payload.failed).toBeUndefined();
    });

    it("mentions people when it publishes, as a post does", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bob");
      await schedule(ann, { content: "Thanks @bob for the tip", publishAt: inMinutes(5) });
      await service.publishDuePosts(later(6));
      const mention = await M.Notification.find({ recipient: bob.user.id, type: "mention" });
      expect(mention).toHaveLength(1);
    });

    it("publishes each post once, even when two runs happen at the same moment", async () => {
      const ann = await signup(app, "ann");
      await schedule(ann, { content: "Only once", publishAt: inMinutes(5) });
      const [a, b] = await Promise.all([service.publishDuePosts(later(6)), service.publishDuePosts(later(6))]);
      expect(a + b).toBe(1);
      expect(await M.Post.countDocuments()).toBe(1);
      expect(await M.Notification.countDocuments({ type: "scheduled_post" })).toBe(1);
    });

    it("picks up one that a run claimed and died on, and makes the same post, not a second", async () => {
      const ann = await signup(app, "ann");
      const made = (await schedule(ann, { content: "Half way", publishAt: inMinutes(5) })).body.post;
      // a run claimed it, fixed its id and made the post, then died before it could finish
      const postId = new (await import("mongoose")).default.Types.ObjectId();
      await M.ScheduledPost.updateOne({ _id: made.id }, { $set: { status: "publishing", claimedAt: later(5), postId } });
      await M.Post.create({ _id: postId, author: ann.user.id, content: "Half way" });
      expect(await service.publishDuePosts(later(6))).toBe(0); // claimed a moment ago: left alone
      expect(await service.publishDuePosts(later(10))).toBe(1);
      expect(await M.Post.countDocuments()).toBe(1);
      expect(await M.ScheduledPost.countDocuments()).toBe(0);
    });

    it("marks one failed when its author can't post any more, says so, and doesn't make a post", async () => {
      const ann = await signup(app, "ann");
      await schedule(ann, { content: "Too late", publishAt: inMinutes(5) });
      await M.User.updateOne({ _id: ann.user.id }, { $set: { suspendedAt: new Date() } });
      expect(await service.publishDuePosts(later(6))).toBe(0);
      expect(await M.Post.countDocuments()).toBe(0);
      const waiting = await M.ScheduledPost.findOne();
      expect(waiting.status).toBe("failed");
      expect(waiting.failure).toMatch(/account/);
      const notice = await M.Notification.findOne({ recipient: ann.user.id, type: "scheduled_post" });
      expect(notice.payload.failed).toBe(true);
    });

    it("shows a failed one to its author, who can give it a new time and have it published", async () => {
      const ann = await signup(app, "ann");
      const made = (await schedule(ann, { content: "Try again", publishAt: inMinutes(5) })).body.post;
      await M.ScheduledPost.updateOne({ _id: made.id }, { $set: { status: "failed", failure: "This post couldn't be published." } });
      const seen = (await list(ann))[0];
      expect(seen).toMatchObject({ failed: true, failure: "This post couldn't be published." });
      const moved = await ann.agent.patch(`/api/scheduled-posts/${made.id}`).send({ publishAt: inMinutes(20) });
      expect(moved.status).toBe(200);
      expect(moved.body.post).toMatchObject({ failed: false, failure: "" });
      expect(await service.publishDuePosts(later(25))).toBe(1);
    });

    it("publishes now when asked, once, answering with the post", async () => {
      const ann = await signup(app, "ann");
      const made = (await schedule(ann, { content: "Right now", publishAt: inMinutes(600) })).body.post;
      const out = await ann.agent.post(`/api/scheduled-posts/${made.id}/publish`);
      expect(out.status).toBe(201);
      expect(out.body.post).toMatchObject({ content: "Right now" });
      expect(await M.Post.countDocuments()).toBe(1);
      expect(await M.ScheduledPost.countDocuments()).toBe(0);
      expect((await ann.agent.post(`/api/scheduled-posts/${made.id}/publish`)).status).toBe(404);
      expect((await feedOf(ann)).map((p) => p.content)).toEqual(["Right now"]);
    });

    it("catches up when someone looks at their notifications", async () => {
      const ann = await signup(app, "ann");
      await M.ScheduledPost.create({ author: ann.user.id, content: "Overdue", publishAt: later(-10) });
      await ann.agent.get("/api/notifications");
      expect(await M.Post.countDocuments()).toBe(1);
    });
  });

  describe("leaving the site", () => {
    it("lists waiting posts in the data download and removes them with the account", async () => {
      const ann = await signup(app, "ann");
      await schedule(ann, { content: "Waiting for its day", publishAt: inMinutes(60), imageAlt: "" });
      const exported = await ann.agent.post("/api/profiles/me/export").send({ password: "password123" });
      expect(exported.status).toBe(200);
      expect(exported.text).toContain("Waiting for its day");
      const gone = await ann.agent.delete("/api/profiles/me").send({ password: "password123" });
      expect(gone.status).toBe(204);
      expect(await M.ScheduledPost.countDocuments()).toBe(0);
    });
  });
});
