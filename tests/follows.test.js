import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.113.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("following", () => {
  let app, Follow, Notification, User, MAX_FOLLOWING;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Follow } = await import("../models/Follow.js"));
    ({ Notification } = await import("../models/Notification.js"));
    ({ User } = await import("../models/User.js"));
    ({ MAX_FOLLOWING } = await import("../routes/follows.routes.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const feedOf = async (who) => (await who.agent.get("/api/posts/feed")).body.posts.map((p) => p.content);
  const post = (who, content) => who.agent.post("/api/posts").send({ content });
  const follow = (who, name) => who.agent.post(`/api/follows/${name}`);

  describe("following someone", () => {
    it("needs a sign-in", async () => {
      expect((await request(app).post("/api/follows/alice")).status).toBe(401);
      expect((await request(app).get("/api/follows/following")).status).toBe(401);
    });
    it("puts a public profile's posts in your feed, without being friends, and stops when you unfollow", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await post(alice, "Alice's public post");
      expect(await feedOf(bob)).toEqual([]);
      expect((await follow(bob, "alice")).status).toBe(201);
      expect(await feedOf(bob)).toEqual(["Alice's public post"]);
      expect(await feedOf(alice)).toEqual(["Alice's public post"]); // following is one-way: Alice sees nothing of Bob's
      expect((await bob.agent.delete("/api/follows/alice")).status).toBe(204);
      expect(await feedOf(bob)).toEqual([]);
    });
    it("is the same when done twice, and unfollowing someone you don't follow is fine", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      expect((await follow(bob, "alice")).status).toBe(201);
      const again = await follow(bob, "alice");
      expect(again.status).toBe(200);
      expect(again.body.following).toBe(true);
      expect(await Follow.countDocuments()).toBe(1);
      expect((await bob.agent.delete("/api/follows/alice")).status).toBe(204);
      expect((await bob.agent.delete("/api/follows/alice")).status).toBe(204);
      expect((await bob.agent.delete("/api/follows/nobody")).status).toBe(204);
      void alice;
    });
    it("is refused with one answer for a missing, private, suspended or blocking profile, and for yourself", async () => {
      const me = await signup(app, "samuel");
      const priv = await signup(app, "private1");
      const gone = await signup(app, "suspone");
      const blocker = await signup(app, "blocker");
      const blocked = await signup(app, "blockedone");
      await priv.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await User.updateOne({ username: "suspone" }, { suspendedAt: new Date() });
      await blocker.agent.post("/api/users/samuel/block");
      await me.agent.post("/api/users/blockedone/block");
      const answers = [];
      for (const name of ["nobodyhere", "private1", "suspone", "blocker", "blockedone"]) {
        const res = await follow(me, name);
        expect(res.status, name).toBe(404);
        answers.push(res.body.error);
      }
      expect(new Set(answers).size).toBe(1);
      const self = await follow(me, "samuel");
      expect(self.status).toBe(400);
      expect(self.body.error).toBe("You can't follow yourself");
      expect(await Follow.countDocuments()).toBe(0);
      void priv; void gone; void blocker; void blocked;
    });
    it("stops at the most people one person can follow", async () => {
      const me = await signup(app, "samuel");
      const target = await signup(app, "targeted");
      await Follow.insertMany(Array.from({ length: MAX_FOLLOWING }, () => ({ follower: me.user.id, following: new mongoose.Types.ObjectId() })));
      const res = await follow(me, "targeted");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/up to 1000/);
      void target;
    });
  });

  describe("what stays private", () => {
    it("a followed profile that goes private drops out of the feed at once", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await post(alice, "visible for now");
      await follow(bob, "alice");
      expect(await feedOf(bob)).toEqual(["visible for now"]);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect(await feedOf(bob)).toEqual([]);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: false });
      expect(await feedOf(bob)).toEqual(["visible for now"]); // public again: the follow is still there
    });
    it("a block ends a follow in both directions, and the feed shows nothing from a blocked person", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await follow(bob, "alice");
      await follow(alice, "bobby");
      await post(alice, "hello");
      await bob.agent.post("/api/users/alice/block");
      expect(await Follow.countDocuments()).toBe(0);
      expect(await feedOf(bob)).toEqual([]);
    });
    it("a suspended person's posts leave the feed of people who follow them", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await post(alice, "soon gone");
      await follow(bob, "alice");
      await User.updateOne({ username: "alice" }, { suspendedAt: new Date() });
      expect(await feedOf(bob)).toEqual([]);
    });
    it("shows only your own lists, never anyone else's", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      await follow(bob, "alice");
      await follow(cara, "alice");
      expect((await alice.agent.get("/api/follows/followers")).body.people.map((p) => p.username).sort()).toEqual(["bobby", "carla"]);
      expect((await alice.agent.get("/api/follows/following")).body.people).toEqual([]);
      expect((await bob.agent.get("/api/follows/following")).body.people.map((p) => p.username)).toEqual(["alice"]);
      expect((await bob.agent.get("/api/follows/followers")).body.people).toEqual([]);
      const text = JSON.stringify((await alice.agent.get("/api/follows/followers")).body);
      expect(text).not.toMatch(/email|passwordHash/);
    });
  });

  describe("counts on a profile", () => {
    it("shows how many follow someone and whom they follow, and whether you do", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      await follow(bob, "alice");
      await follow(cara, "alice");
      await follow(alice, "carla");
      const seenByBob = (await bob.agent.get("/api/profiles/alice")).body.user;
      expect(seenByBob).toMatchObject({ followerCount: 2, followingCount: 1, iFollow: true });
      const seenByAnon = (await request(app).get("/api/profiles/alice")).body.user;
      expect(seenByAnon).toMatchObject({ followerCount: 2, followingCount: 1 });
      expect(seenByAnon.iFollow).toBeUndefined();
      const own = (await alice.agent.get("/api/profiles/alice")).body.user;
      expect(own.followerCount).toBe(2);
      expect(own.iFollow).toBeUndefined();
    });
    it("shows counts on a private profile to a friend, and nothing at all to a stranger", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await befriend(alice, bob);
      expect((await bob.agent.get("/api/profiles/alice")).body.user.followerCount).toBe(0);
      const stranger = await cara.agent.get("/api/profiles/alice"); // a private profile isn't opened at all by a stranger
      expect(stranger.status).toBe(403);
      expect(stranger.body.user).toBeUndefined();
    });
  });

  describe("telling the person", () => {
    it("sends one notice, with who followed, and not again when someone unfollows and follows right back", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await follow(bob, "alice");
      await bob.agent.delete("/api/follows/alice");
      await follow(bob, "alice");
      const notes = await Notification.find({ recipient: alice.user.id, type: "follow" }).lean();
      expect(notes).toHaveLength(1);
      expect(notes[0].payload.actorId).toBe(bob.user.id);
      const list = (await alice.agent.get("/api/notifications")).body.notifications.find((n) => n.type === "follow");
      expect(list.actor.username).toBe("bobby");
    });
  });

  describe("tidying up", () => {
    it("deleting an account removes its follows both ways, and the data download lists whom you follow", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await follow(bob, "alice");
      await follow(alice, "bobby");
      const download = await bob.agent.post("/api/profiles/me/export").send({ password: "password123" });
      expect(JSON.parse(download.text).following).toEqual(["alice"]);
      expect((await bob.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await Follow.countDocuments()).toBe(0);
    });
  });
});
