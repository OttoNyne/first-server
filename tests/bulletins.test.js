import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.104.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  if (extra.private) await agent.patch("/api/profiles/me").send({ isPrivate: true });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("bulletins", () => {
  let app, Bulletin, Report;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Bulletin } = await import("../models/Bulletin.js"));
    ({ Report } = await import("../models/Report.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const post = (who, over = {}) => who.agent.post("/api/bulletins").send({ title: "Show on Friday", body: "Come along!\n\nDoors at 7.", ...over });
  const board = async (who) => (await who.agent.get("/api/bulletins")).body.bulletins;
  const unread = async (who) => (await who.agent.get("/api/bulletins/unread-count")).body.unread;

  it("needs a sign-in", async () => {
    for (const [method, path] of [["get", "/api/bulletins"], ["get", "/api/bulletins/unread-count"], ["post", "/api/bulletins"], ["post", "/api/bulletins/seen"], ["delete", "/api/bulletins/5f1d7f3b8f1d7f3b8f1d7f3b"]]) {
      expect((await request(app)[method](path)).status, `${method} ${path}`).toBe(401);
    }
  });

  describe("posting", () => {
    it("posts a bulletin, cleaned up, that expires in about ten days", async () => {
      const alice = await signup(app, "alice");
      const res = await post(alice, { title: "  Show   on​ Friday ", body: "  One.\r\n\r\n\r\n\r\nTwo.  " });
      expect(res.status).toBe(201);
      expect(res.body.bulletin).toMatchObject({ title: "Show on Friday", body: "One.\n\nTwo.", isMine: true });
      expect(res.body.bulletin.author.username).toBe("alice");
      const days = (new Date(res.body.bulletin.expiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(9.9);
      expect(days).toBeLessThanOrEqual(10);
    });

    it("checks the title and the text", async () => {
      const alice = await signup(app, "alice");
      for (const title of ["", "   ", undefined, 4, "x".repeat(81)]) expect((await post(alice, { title })).status, String(title)).toBe(400);
      for (const body of ["", " \n ", undefined, 4, ["a"], "x".repeat(501)]) expect((await post(alice, { body })).status, String(body).slice(0, 8)).toBe(400);
      expect(await Bulletin.countDocuments()).toBe(0);
      expect((await post(alice, { body: "x".repeat(500) })).status).toBe(201);
    });

    it("limits how many a day, and how many are up at once", async () => {
      const alice = await signup(app, "alice");
      for (let i = 0; i < 5; i++) expect((await post(alice, { title: `Bulletin ${i}` })).status).toBe(201);
      const limited = await post(alice);
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeTruthy();

      const bob = await signup(app, "bobby");
      await Bulletin.insertMany(Array.from({ length: 10 }, (_, i) => ({ author: bob.user.id, title: `Up ${i}`, body: "x", expireAt: new Date(Date.now() + 86_400_000) })));
      expect((await post(bob)).status).toBe(400);
    });

    it("takes the author from the session, whatever the body says", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const res = await post(alice, { author: bob.user.id, expireAt: "2099-01-01", createdAt: "2001-01-01" });
      const saved = await Bulletin.findById(res.body.bulletin.id);
      expect(String(saved.author)).toBe(alice.user.id);
      expect(saved.expireAt.getFullYear()).toBeLessThan(2090);
      expect(saved.createdAt.getFullYear()).toBeGreaterThan(2020);
    });
  });

  describe("who can read them", () => {
    it("shows your own and your friends', newest first, and nobody else's", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      await befriend(alice, bob);
      await Bulletin.create({ author: alice.user.id, title: "Older", body: "x", expireAt: new Date(Date.now() + 1e9), createdAt: new Date(Date.now() - 5000) });
      await post(alice, { title: "Newer" });
      await post(cara, { title: "Stranger's" });
      expect((await board(bob)).map((b) => b.title)).toEqual(["Newer", "Older"]);
      expect((await board(bob))[0]).toMatchObject({ isMine: false, author: { username: "alice" } });
      expect((await board(alice)).map((b) => [b.title, b.isMine])).toEqual([["Newer", true], ["Older", true]]);
      expect((await board(cara)).map((b) => b.title)).toEqual(["Stranger's"]);
    });

    it("is for friends even when the author's profile is public, and not for people who only asked", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await post(alice);
      await bob.agent.post(`/api/friends/request/alice`); // pending
      expect(await board(bob)).toEqual([]);
    });

    it("stops showing them when you stop being friends or one of you blocks the other", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      await post(alice);
      expect(await board(bob)).toHaveLength(1);
      await bob.agent.post("/api/users/alice/block");
      expect(await board(bob)).toEqual([]);
      expect(await unread(bob)).toBe(0);
      await bob.agent.delete("/api/users/alice/block");
      expect(await board(bob)).toEqual([]); // blocking ended the friendship
    });

    it("leaves out expired ones", async () => {
      const alice = await signup(app, "alice");
      await Bulletin.create({ author: alice.user.id, title: "Gone", body: "x", expireAt: new Date(Date.now() - 1000) });
      expect(await board(alice)).toEqual([]);
    });

    it("shows at most 50", async () => {
      const alice = await signup(app, "alice");
      await Bulletin.insertMany(Array.from({ length: 60 }, (_, i) => ({ author: alice.user.id, title: `B${i}`, body: "x", expireAt: new Date(Date.now() + 1e9) })));
      expect(await board(alice)).toHaveLength(50);
    });
  });

  describe("the unread badge", () => {
    it("counts friends' bulletins you haven't seen, never your own, and clears when you look", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      await befriend(alice, bob);
      expect(await unread(bob)).toBe(0);
      await post(alice, { title: "One" });
      await post(alice, { title: "Two" });
      await post(cara, { title: "Not a friend" });
      await post(bob, { title: "Mine" });
      expect(await unread(bob)).toBe(2);
      expect(await unread(alice)).toBe(1); // bob's
      expect((await bob.agent.post("/api/bulletins/seen")).status).toBe(204);
      expect(await unread(bob)).toBe(0);
      await new Promise((r) => setTimeout(r, 20));
      await post(alice, { title: "Three" });
      expect(await unread(bob)).toBe(1);
    });

    it("doesn't expose the seen time on profiles", async () => {
      const alice = await signup(app, "alice");
      await alice.agent.post("/api/bulletins/seen");
      const me = (await alice.agent.get("/api/profiles/alice")).body.user;
      expect(JSON.stringify(me)).not.toContain("bulletinsSeenAt");
    });
  });

  describe("taking one down, reports and account deletion", () => {
    it("lets only the author delete one, and answers others as if it didn't exist", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      const b = (await post(alice)).body.bulletin;
      expect((await bob.agent.delete(`/api/bulletins/${b.id}`)).status).toBe(404);
      expect(await Bulletin.countDocuments()).toBe(1);
      expect((await alice.agent.delete("/api/bulletins/not-an-id")).status).toBe(404);
      expect((await alice.agent.delete(`/api/bulletins/${b.id}`)).status).toBe(204);
      expect(await board(bob)).toEqual([]);
      expect((await alice.agent.delete(`/api/bulletins/${b.id}`)).status).toBe(404);
    });

    it("can be reported", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      const b = (await post(alice)).body.bulletin;
      expect((await bob.agent.post("/api/reports").send({ targetType: "bulletin", targetId: b.id, reason: "spam" })).status).toBe(201);
    });

    it("goes with the account, with its reports", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      const b = (await post(alice)).body.bulletin;
      await bob.agent.post("/api/reports").send({ targetType: "bulletin", targetId: b.id, reason: "spam" });
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await Bulletin.countDocuments()).toBe(0);
      expect(await Report.countDocuments({ targetType: "bulletin" })).toBe(0);
      expect(await board(bob)).toEqual([]);
    });
  });
});
