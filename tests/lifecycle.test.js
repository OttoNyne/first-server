import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

// No real Cloudinary calls: record what would be destroyed.
const destroy = vi.fn().mockResolvedValue({ result: "ok" });
vi.mock("cloudinary", () => ({
  v2: {
    config: vi.fn(),
    uploader: { destroy: (...args) => destroy(...args), upload: vi.fn(), upload_stream: vi.fn() },
  },
}));

const PASSWORD = "password123";

async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({
    email: `${name}@example.com`,
    username: name,
    password: PASSWORD,
    displayName: name,
  });
  return { agent, user: res.body.user };
}

describe("account deletion, asset cleanup and offer replies", () => {
  let app;
  let m; // models

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    m = {
      User: (await import("../models/User.js")).User,
      Post: (await import("../models/Post.js")).Post,
      Comment: (await import("../models/Comment.js")).Comment,
      Task: (await import("../models/Task.js")).Task,
      Group: (await import("../models/Group.js")).Group,
      GroupMembership: (await import("../models/GroupMembership.js")).GroupMembership,
      Friendship: (await import("../models/Friendship.js")).Friendship,
      Notification: (await import("../models/Notification.js")).Notification,
      StoredAsset: (await import("../models/StoredAsset.js")).StoredAsset,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    destroy.mockClear();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  describe("DELETE /api/profiles/me", () => {
    it("requires being signed in and the correct password", async () => {
      const alice = await signup(app, "alice");

      expect((await request(app).delete("/api/profiles/me").send({ password: PASSWORD })).status).toBe(401);
      expect((await alice.agent.delete("/api/profiles/me").send({})).status).toBe(400);
      const wrong = await alice.agent.delete("/api/profiles/me").send({ password: "not-my-password" });
      expect(wrong.status).toBe(403);

      expect(await m.User.countDocuments({ username: "alice" })).toBe(1);
    });

    it("throttles repeated wrong passwords", async () => {
      const alice = await signup(app, "alice");
      for (let i = 0; i < 5; i++) {
        expect((await alice.agent.delete("/api/profiles/me").send({ password: "wrong-wrong" })).status).toBe(403);
      }
      const blocked = await alice.agent.delete("/api/profiles/me").send({ password: PASSWORD });
      expect(blocked.status).toBe(429);
      expect(await m.User.countDocuments({ username: "alice" })).toBe(1);
    }, 60_000);

    it("removes the account and everything it owns, but nothing that belongs to others", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");

      // Alice's content, plus interactions with Bob.
      const alicePost = (await alice.agent.post("/api/posts").send({ content: "hello" })).body.post.id;
      const bobPost = (await bob.agent.post("/api/posts").send({ content: "bob's post" })).body.post.id;
      await bob.agent.post(`/api/posts/${alicePost}/comments`).send({ content: "nice" });
      await alice.agent.post(`/api/posts/${bobPost}/comments`).send({ content: "alice on bob" });
      await alice.agent.post("/api/tasks").send({ title: "alice request", isPublic: true });
      await m.Friendship.create({ requester: alice.user.id, addressee: bob.user.id, status: "accepted" });
      await m.StoredAsset.create({ owner: alice.user.id, url: "https://x/a.jpg", publicId: "creativeselect/a", kind: "upload" });
      await m.StoredAsset.create({
        owner: alice.user.id,
        url: "https://x/song.mp3",
        publicId: "creativeselect/tracks/song",
        resourceType: "video",
        kind: "upload",
      });

      // A copy of her session token, taken before she deletes the account.
      const copiedToken = (
        await request(app).post("/api/auth/login").send({ email: "alice@example.com", password: PASSWORD })
      ).headers["set-cookie"][0].split(";")[0];

      const res = await alice.agent.delete("/api/profiles/me").send({ password: PASSWORD });
      expect(res.status).toBe(204);
      expect(res.headers["set-cookie"].join(";")).toMatch(/token=;/);

      // Alice and hers are gone...
      expect(await m.User.countDocuments({ username: "alice" })).toBe(0);
      expect(await m.Post.countDocuments({ author: alice.user.id })).toBe(0);
      expect(await m.Comment.countDocuments()).toBe(0); // her comment AND the comment on her post
      expect(await m.Task.countDocuments({ owner: alice.user.id })).toBe(0);
      expect(await m.Friendship.countDocuments()).toBe(0);
      expect(await m.StoredAsset.countDocuments()).toBe(0);
      expect(destroy).toHaveBeenCalledWith("creativeselect/a", { resource_type: "image", invalidate: true });
      expect(destroy).toHaveBeenCalledWith("creativeselect/tracks/song", { resource_type: "video", invalidate: true });

      // ...Bob and his are not.
      expect(await m.User.countDocuments({ username: "bob" })).toBe(1);
      expect(await m.Post.countDocuments({ author: bob.user.id })).toBe(1);

      // The copied token is worthless afterwards, even on routes that never load
      // the user (it must not be able to create orphan data under a deleted id).
      const replay = await request(app).post("/api/posts").set("Cookie", copiedToken).send({ content: "ghost" });
      expect(replay.status).toBe(401);
      expect(await m.Post.countDocuments({ content: "ghost" })).toBe(0);

      // The deleted account can no longer sign in, and its old session is dead.
      const login = await request(app).post("/api/auth/login").send({ email: "alice@example.com", password: PASSWORD });
      expect(login.status).toBe(401);
      expect((await alice.agent.get("/api/auth/me")).status).toBe(401);
    });

    it("hands a shared group to another member and deletes an empty one", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const shared = await m.Group.create({ name: "Shared", createdBy: alice.user.id });
      await m.GroupMembership.create({ group: shared._id, user: alice.user.id, role: "admin" });
      await m.GroupMembership.create({ group: shared._id, user: bob.user.id, role: "member" });
      const solo = await m.Group.create({ name: "Solo", createdBy: alice.user.id });
      await m.GroupMembership.create({ group: solo._id, user: alice.user.id, role: "admin" });

      await alice.agent.delete("/api/profiles/me").send({ password: PASSWORD });

      const kept = await m.Group.findById(shared._id);
      expect(String(kept.createdBy)).toBe(bob.user.id);
      const bobMembership = await m.GroupMembership.findOne({ group: shared._id, user: bob.user.id });
      expect(bobMembership.role).toBe("admin");
      expect(await m.Group.findById(solo._id)).toBeNull();
      expect(await m.GroupMembership.countDocuments({ user: alice.user.id })).toBe(0);
    });
  });

  describe("replacing a wallpaper or avatar", () => {
    const OLD = "https://res.cloudinary.com/demo/image/upload/creativeselect/wallpapers/old.jpg";

    it("deletes the old stored file once nothing uses it", async () => {
      const alice = await signup(app, "alice");
      await m.StoredAsset.create({ owner: alice.user.id, url: OLD, publicId: "creativeselect/wallpapers/old", kind: "upload" });
      await alice.agent.patch("/api/profiles/me").send({ wallpaperUrl: OLD });

      await alice.agent.patch("/api/profiles/me").send({ wallpaperUrl: "https://images.example.com/new.jpg" });

      expect(destroy).toHaveBeenCalledWith("creativeselect/wallpapers/old", { resource_type: "image", invalidate: true });
    });

    it("keeps it if a post still uses it, and ignores files it didn't store", async () => {
      const alice = await signup(app, "alice");
      await m.StoredAsset.create({ owner: alice.user.id, url: OLD, publicId: "creativeselect/wallpapers/old", kind: "upload" });
      await alice.agent.patch("/api/profiles/me").send({ wallpaperUrl: OLD });
      await alice.agent.post("/api/posts").send({ content: "same pic", imageUrl: OLD });
      await alice.agent.patch("/api/profiles/me").send({ wallpaperUrl: "https://images.example.com/new.jpg" });
      expect(destroy).not.toHaveBeenCalled();

      await alice.agent.patch("/api/profiles/me").send({ avatarUrl: "https://images.example.com/a.jpg" });
      await alice.agent.patch("/api/profiles/me").send({ avatarUrl: "https://images.example.com/b.jpg" });
      expect(destroy).not.toHaveBeenCalled();
    });
  });

  describe("replying to help offers", () => {
    async function offerSetup() {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const task = (await alice.agent.post("/api/tasks").send({ title: "logo help", isPublic: true })).body;
      return { alice, bob, task };
    }
    async function offersFor(agent) {
      return (await agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "help_offer");
    }

    it("carries an optional, trimmed, length-limited message", async () => {
      const { alice, bob, task } = await offerSetup();
      const res = await bob.agent.post(`/api/tasks/${task._id}/offer`).send({ message: `  I can help!  ${"x".repeat(400)}` });
      expect(res.status).toBe(201);
      const [offer] = await offersFor(alice.agent);
      expect(offer.payload.message.startsWith("I can help!")).toBe(true);
      expect(offer.payload.message.length).toBe(300);
      expect(offer.payload.accepted).toBe(false);
    });

    it("rejects a message that isn't text", async () => {
      const { bob, task } = await offerSetup();
      const res = await bob.agent.post(`/api/tasks/${task._id}/offer`).send({ message: { evil: true } });
      expect(res.status).toBe(400);
    });

    it("lets the owner accept, notifying the offerer exactly once", async () => {
      const { alice, bob, task } = await offerSetup();
      await bob.agent.post(`/api/tasks/${task._id}/offer`).send({});
      const [offer] = await offersFor(alice.agent);

      expect((await alice.agent.post(`/api/notifications/${offer.id}/accept-offer`)).status).toBe(201);
      expect((await alice.agent.post(`/api/notifications/${offer.id}/accept-offer`)).status).toBe(200);

      const accepted = (await bob.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "help_accepted");
      expect(accepted).toHaveLength(1);
      expect(accepted[0].actor.username).toBe("alice");
      expect(accepted[0].payload.title).toBe("logo help");
      expect((await offersFor(alice.agent))[0].payload.accepted).toBe(true);
    });

    it("only lets the recipient of an offer accept it", async () => {
      const { alice, bob, task } = await offerSetup();
      await bob.agent.post(`/api/tasks/${task._id}/offer`).send({});
      const [offer] = await offersFor(alice.agent);

      expect((await bob.agent.post(`/api/notifications/${offer.id}/accept-offer`)).status).toBe(404);
      expect((await bob.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "help_accepted")).toHaveLength(0);
    });
  });
});
