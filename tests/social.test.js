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

describe("friends, groups, moderation and media", () => {
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

  const friendNames = async (agent) => (await agent.get("/api/friends")).body.friends.map((f) => f.username);

  describe("friends", () => {
    it("requires sign-in for every route", async () => {
      expect((await request(app).get("/api/friends")).status).toBe(401);
      expect((await request(app).post("/api/friends/request/someone")).status).toBe(401);
      expect((await request(app).post("/api/friends/accept/abc")).status).toBe(401);
    });

    it("sends a request (with a notification) and rejects duplicates in either direction", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");

      const sent = await alice.agent.post("/api/friends/request/bob");
      expect(sent.status).toBe(201);
      expect(await Notification.countDocuments({ recipient: bob.user.id, type: "friend_request" })).toBe(1);

      expect((await alice.agent.post("/api/friends/request/bob")).status).toBe(409);
      expect((await bob.agent.post("/api/friends/request/alice")).status).toBe(409);
    });

    it("rejects friending yourself or someone who doesn't exist", async () => {
      const alice = await signup(app, "alice");
      expect((await alice.agent.post("/api/friends/request/alice")).status).toBe(400);
      expect((await alice.agent.post("/api/friends/request/ghost")).status).toBe(404);
    });

    it("only the addressee can accept, and acceptance makes both sides friends", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const carol = await signup(app, "carol");
      const { friendship } = (await alice.agent.post("/api/friends/request/bob")).body;

      expect((await alice.agent.post(`/api/friends/accept/${friendship._id}`)).status).toBe(404); // the requester
      expect((await carol.agent.post(`/api/friends/accept/${friendship._id}`)).status).toBe(404); // a stranger
      expect(await friendNames(bob.agent)).toEqual([]);

      const requests = (await bob.agent.get("/api/friends/requests")).body.requests;
      expect(requests).toHaveLength(1);
      expect(requests[0].requester.username).toBe("alice");
      expect((await alice.agent.get("/api/friends/requests")).body.requests).toHaveLength(0);

      expect((await bob.agent.post(`/api/friends/accept/${friendship._id}`)).status).toBe(200);
      expect(await friendNames(alice.agent)).toEqual(["bob"]);
      expect(await friendNames(bob.agent)).toEqual(["alice"]);
      expect(await Notification.countDocuments({ recipient: alice.user.id, type: "friend_accept" })).toBe(1);
    });

    it("declining keeps them out of the friends list", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const { friendship } = (await alice.agent.post("/api/friends/request/bob")).body;

      expect((await bob.agent.post(`/api/friends/decline/${friendship._id}`)).status).toBe(200);
      expect(await friendNames(alice.agent)).toEqual([]);
      expect((await bob.agent.get("/api/friends/requests")).body.requests).toHaveLength(0);
    });

    it("either side can remove an accepted friendship", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const { friendship } = (await alice.agent.post("/api/friends/request/bob")).body;
      await bob.agent.post(`/api/friends/accept/${friendship._id}`);

      expect((await alice.agent.delete(`/api/friends/${bob.user.id}`)).status).toBe(204);
      expect(await friendNames(alice.agent)).toEqual([]);
      expect(await friendNames(bob.agent)).toEqual([]);
    });

    it("treats a malformed id as a client error, not a crash", async () => {
      const alice = await signup(app, "alice");
      expect((await alice.agent.post("/api/friends/accept/not-an-id")).status).toBe(400);
    });
  });

  describe("blocking and reports", () => {
    it("blocking removes an existing friendship and prevents new requests both ways", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const { friendship } = (await alice.agent.post("/api/friends/request/bob")).body;
      await bob.agent.post(`/api/friends/accept/${friendship._id}`);

      expect((await alice.agent.post("/api/users/bob/block")).status).toBe(204);
      expect(await friendNames(bob.agent)).toEqual([]);
      expect((await alice.agent.post("/api/friends/request/bob")).status).toBe(403);
      expect((await bob.agent.post("/api/friends/request/alice")).status).toBe(403);

      expect((await alice.agent.delete("/api/users/bob/block")).status).toBe(204);
      expect((await alice.agent.post("/api/friends/request/bob")).status).toBe(201);
    });

    it("can't block yourself or a missing user, and blocking twice is harmless", async () => {
      const alice = await signup(app, "alice");
      await signup(app, "bob");
      expect((await alice.agent.post("/api/users/alice/block")).status).toBe(400);
      expect((await alice.agent.post("/api/users/ghost/block")).status).toBe(404);
      expect((await alice.agent.post("/api/users/bob/block")).status).toBe(204);
      expect((await alice.agent.post("/api/users/bob/block")).status).toBe(204);
    });

    it("validates reports", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const bad = await alice.agent.post("/api/reports").send({ targetType: "spaceship", targetId: bob.user.id, reason: "x" });
      expect(bad.status).toBe(400);
      expect((await alice.agent.post("/api/reports").send({ targetType: "user", reason: "spam" })).status).toBe(400);
      const ok = await alice.agent.post("/api/reports").send({ targetType: "user", targetId: bob.user.id, reason: "spam" });
      expect(ok.status).toBe(201);
      expect((await request(app).post("/api/reports").send({})).status).toBe(401);
    });
  });

  describe("groups", () => {
    it("requires sign-in", async () => {
      expect((await request(app).get("/api/groups")).status).toBe(401);
      expect((await request(app).post("/api/groups").send({ name: "x" })).status).toBe(401);
    });

    it("creating a group makes the creator its admin member", async () => {
      const alice = await signup(app, "alice");
      const res = await alice.agent.post("/api/groups").send({ name: "Painters", description: "We paint" });
      expect(res.status).toBe(201);
      expect(res.body.group).toMatchObject({ name: "Painters", memberCount: 1, isMember: true });

      const members = (await alice.agent.get(`/api/groups/${res.body.group.id}/members`)).body.members;
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ role: "admin" });
      expect(members[0].user.username).toBe("alice");
    });

    it("rejects a group with no name", async () => {
      const alice = await signup(app, "alice");
      expect((await alice.agent.post("/api/groups").send({ description: "nameless" })).status).toBe(400);
    });

    it("lets others join once, leave, and see the member count change", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const id = (await alice.agent.post("/api/groups").send({ name: "Painters" })).body.group.id;

      expect((await bob.agent.post(`/api/groups/${id}/join`)).status).toBe(204);
      expect((await bob.agent.post(`/api/groups/${id}/join`)).status).toBe(409);
      let group = (await bob.agent.get(`/api/groups/${id}`)).body.group;
      expect(group).toMatchObject({ memberCount: 2, isMember: true });

      expect((await bob.agent.post(`/api/groups/${id}/leave`)).status).toBe(204);
      group = (await bob.agent.get(`/api/groups/${id}`)).body.group;
      expect(group).toMatchObject({ memberCount: 1, isMember: false });
    });

    it("404s for a group that doesn't exist and 400s a malformed id", async () => {
      const alice = await signup(app, "alice");
      expect((await alice.agent.get("/api/groups/64b0f0f0f0f0f0f0f0f0f0f0")).status).toBe(404);
      expect((await alice.agent.post("/api/groups/64b0f0f0f0f0f0f0f0f0f0f0/join")).status).toBe(404);
      expect((await alice.agent.get("/api/groups/nope")).status).toBe(400);
    });

    it("searches by name, treating the query as text and not a regex", async () => {
      const alice = await signup(app, "alice");
      await alice.agent.post("/api/groups").send({ name: "Painters" });
      await alice.agent.post("/api/groups").send({ name: "Potters" });

      const names = async (q) => (await alice.agent.get(`/api/groups?search=${encodeURIComponent(q)}`)).body.groups.map((g) => g.name);
      expect(await names("paint")).toEqual(["Painters"]);
      expect(await names(".*")).toEqual([]); // would match everything if unescaped
      expect((await names("")).sort()).toEqual(["Painters", "Potters"]);
    });
  });

  describe("media (portfolio) items", () => {
    const image = "https://images.example.com/piece.jpg";

    it("lets an owner add and delete an item, and nobody else delete it", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const created = await alice.agent.post("/api/media").send({ url: image, type: "image", caption: "sketch" });
      expect(created.status).toBe(201);
      const id = created.body.mediaItem.id;

      expect((await bob.agent.delete(`/api/media/${id}`)).status).toBe(403);
      expect((await alice.agent.delete("/api/media/64b0f0f0f0f0f0f0f0f0f0f0")).status).toBe(404);
      expect((await alice.agent.delete(`/api/media/${id}`)).status).toBe(204);
      expect((await alice.agent.get("/api/media/user/alice")).body.media).toEqual([]);
    });

    it("rejects an item with an invalid type", async () => {
      const alice = await signup(app, "alice");
      const res = await alice.agent.post("/api/media").send({ url: image, type: "exe" });
      expect(res.status).toBe(400);
    });

    it("respects profile privacy and blocks", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const carol = await signup(app, "carol");
      await alice.agent.post("/api/media").send({ url: image, type: "image" });

      // Public: anyone (even signed out) sees it.
      expect((await request(app).get("/api/media/user/alice")).body.media).toHaveLength(1);

      // Private: friends and the owner only.
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await request(app).get("/api/media/user/alice")).status).toBe(403);
      expect((await bob.agent.get("/api/media/user/alice")).status).toBe(403);
      expect((await alice.agent.get("/api/media/user/alice")).body.media).toHaveLength(1);
      const { friendship } = (await bob.agent.post("/api/friends/request/alice")).body;
      await alice.agent.post(`/api/friends/accept/${friendship._id}`);
      expect((await bob.agent.get("/api/media/user/alice")).body.media).toHaveLength(1);

      // Blocked users lose access even on a public profile.
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: false });
      await alice.agent.post("/api/users/carol/block");
      expect((await carol.agent.get("/api/media/user/alice")).status).toBe(403);
    });
  });
});
