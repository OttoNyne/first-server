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

describe("editing your profile: display name, username, top friends", () => {
  let app;
  let UsernameHistory;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ UsernameHistory } = await import("../models/UsernameHistory.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  describe("display name", () => {
    it("changes and trims the display name", async () => {
      const alice = await signup(app, "alice");
      const res = await alice.agent.patch("/api/profiles/me").send({ displayName: "  Alice the Painter  " });
      expect(res.status).toBe(200);
      expect(res.body.user.displayName).toBe("Alice the Painter");
    });

    it("rejects an empty, blank, over-long or non-text display name", async () => {
      const alice = await signup(app, "alice");
      for (const bad of ["", "   ", "x".repeat(81), 42, { a: 1 }]) {
        const res = await alice.agent.patch("/api/profiles/me").send({ displayName: bad });
        expect(res.status).toBe(400);
      }
      expect((await alice.agent.get("/api/auth/me")).body.user.displayName).toBe("alice");
    });

    it("rejects an over-long or non-text bio", async () => {
      const alice = await signup(app, "alice");
      expect((await alice.agent.patch("/api/profiles/me").send({ bio: "x".repeat(1001) })).status).toBe(400);
      expect((await alice.agent.patch("/api/profiles/me").send({ bio: { evil: true } })).status).toBe(400);
      expect((await alice.agent.patch("/api/profiles/me").send({ bio: "hello" })).status).toBe(200);
    });
  });

  describe("username", () => {
    const put = (agent, username) => agent.put("/api/profiles/me/username").send({ username });

    it("requires being signed in", async () => {
      expect((await request(app).put("/api/profiles/me/username").send({ username: "newname" })).status).toBe(401);
    });

    it("changes the username (stored lowercase); the new profile URL works and the old one doesn't", async () => {
      const alice = await signup(app, "alice");
      const res = await put(alice.agent, "Alice_Paints");
      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe("alice_paints");

      expect((await alice.agent.get("/api/profiles/alice_paints")).status).toBe(200);
      expect((await alice.agent.get("/api/profiles/alice")).status).toBe(404);
      // the session keeps working, and /me reflects the change
      expect((await alice.agent.get("/api/auth/me")).body.user.username).toBe("alice_paints");
    });

    it("rejects names that are too short, too long, or not URL-safe", async () => {
      const alice = await signup(app, "alice");
      for (const bad of ["ab", "x".repeat(31), "has space", "slash/name", "émile", "a.b", "<script>", "", 5, null]) {
        const res = await put(alice.agent, bad);
        expect(res.status).toBe(400);
      }
      expect((await alice.agent.get("/api/auth/me")).body.user.username).toBe("alice");
    });

    it("refuses a name someone else already has, ignoring case", async () => {
      const alice = await signup(app, "alice");
      await signup(app, "bobby");
      expect((await put(alice.agent, "bobby")).status).toBe(409);
      expect((await put(alice.agent, "BOBBY")).status).toBe(409);
    });

    it("treats re-submitting your own name as a no-op that doesn't use up a change", async () => {
      const alice = await signup(app, "alice");
      for (let i = 0; i < 5; i++) expect((await put(alice.agent, "Alice")).status).toBe(200);
      expect((await put(alice.agent, "alice_2")).status).toBe(200);
    });

    it("reserves the name you give up for 30 days: others can't take it or register it, you can reclaim it", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      await put(alice.agent, "alice_new");

      const taken = await put(bobby.agent, "alice");
      expect(taken.status).toBe(409);
      expect(taken.body.error).toMatch(/recently used/i);
      const reg = await request(app)
        .post("/api/auth/register")
        .send({ email: "sneaky@example.com", username: "alice", password: "password123", displayName: "Sneaky" });
      expect(reg.status).toBe(409);

      expect(await UsernameHistory.countDocuments({ username: "alice" })).toBe(1);
      expect((await put(alice.agent, "alice")).status).toBe(200); // the original owner may go back
    });

    it("allows 3 changes a day, then 429s", async () => {
      const alice = await signup(app, "alice");
      for (const n of ["alice_a", "alice_b", "alice_c"]) expect((await put(alice.agent, n)).status).toBe(200);
      const over = await put(alice.agent, "alice_d");
      expect(over.status).toBe(429);
      expect((await alice.agent.get("/api/auth/me")).body.user.username).toBe("alice_c");
    }, 30_000);

    it("registration applies the same URL-safe rule", async () => {
      for (const bad of ["has space", "slash/name", "a.b", "ab"]) {
        const res = await request(app)
          .post("/api/auth/register")
          .send({ email: "x@example.com", username: bad, password: "password123", displayName: "X" });
        expect(res.status).toBe(400);
      }
    });
  });

  describe("top friends", () => {
    async function befriend(a, b) {
      const { friendship } = (await a.agent.post(`/api/friends/request/${b.user.username}`)).body;
      await b.agent.post(`/api/friends/accept/${friendship._id}`);
    }

    it("saves and returns the list (the response the UI reads), in the order given", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      await befriend(alice, bobby);
      await befriend(alice, carol);

      const res = await alice.agent.put("/api/profiles/me/top-friends").send({ usernames: ["carol", "bobby"] });
      expect(res.status).toBe(200);
      expect(res.body.topFriends.map((u) => u.username)).toEqual(["carol", "bobby"]);

      const read = await request(app).get("/api/profiles/alice/top-friends");
      expect(read.body.topFriends.map((u) => u.username)).toEqual(["carol", "bobby"]);
    });

    it("ignores people who aren't accepted friends, duplicates and non-text entries", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      await signup(app, "stranger");
      await befriend(alice, bobby);

      const res = await alice.agent
        .put("/api/profiles/me/top-friends")
        .send({ usernames: ["stranger", "bobby", "bobby", 7, null, "ghost"] });
      expect(res.status).toBe(200);
      expect(res.body.topFriends.map((u) => u.username)).toEqual(["bobby"]);
    });

    it("clears the list when given an empty array, and requires sign-in", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      await befriend(alice, bobby);
      await alice.agent.put("/api/profiles/me/top-friends").send({ usernames: ["bobby"] });

      const cleared = await alice.agent.put("/api/profiles/me/top-friends").send({ usernames: [] });
      expect(cleared.status).toBe(200);
      expect(cleared.body.topFriends).toEqual([]);
      expect((await request(app).put("/api/profiles/me/top-friends").send({ usernames: [] })).status).toBe(401);
    });
  });
});
