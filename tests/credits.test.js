import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.108.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  if (extra.private) await agent.patch("/api/profiles/me").send({ isPrivate: true });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("credits on portfolio pieces", () => {
  let app, MediaItem, Credit, Notification, User;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ MediaItem } = await import("../models/MediaItem.js"));
    ({ Credit } = await import("../models/Credit.js"));
    ({ Notification } = await import("../models/Notification.js"));
    ({ User } = await import("../models/User.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const piece = (who, n = 1) => MediaItem.create({ owner: who.user.id, url: `https://example.com/p${n}.jpg`, type: "image" });
  const credit = (who, item, username, role = "Illustrator") => who.agent.post(`/api/credits/for/${item._id}`).send({ username, role });
  const creditsOn = async (viewer, ownerName, item) => {
    const list = (await (viewer?.agent ?? request(app)).get(`/api/media/user/${ownerName}`)).body.media;
    return list.find((m) => m.id === String(item._id))?.credits;
  };

  async function trio() {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    const cara = await signup(app, "cara");
    await befriend(alice, bob);
    await befriend(alice, cara);
    return { alice, bob, cara };
  }

  describe("asking", () => {
    it("lets the owner credit a friend, with a cleaned-up role, and tells that friend", async () => {
      const { alice, bob } = await trio();
      const item = await piece(alice);
      const res = await credit(alice, item, "bob", "  Cover   illustrator ");
      expect(res.status).toBe(201);
      expect(res.body.credit).toMatchObject({ role: "Cover illustrator", status: "pending", user: { username: "bob" } });
      const note = await Notification.findOne({ recipient: bob.user.id, type: "credit_request" });
      expect(note.payload).toMatchObject({ actorId: alice.user.id, itemId: String(item._id), role: "Cover illustrator" });
    });

    it("needs a sign-in, and only the owner of the piece can credit on it", async () => {
      const { alice, bob, cara } = await trio();
      const item = await piece(alice);
      expect((await request(app).post(`/api/credits/for/${item._id}`).send({ username: "bob", role: "x" })).status).toBe(401);
      expect((await credit(bob, item, "cara")).status).toBe(404);
      expect((await credit(cara, item, "bob")).status).toBe(404);
      expect(await Credit.countDocuments()).toBe(0);
      expect((await alice.agent.post("/api/credits/for/not-an-id").send({ username: "bob", role: "x" })).status).toBe(404);
    });

    it("only credits friends: not strangers, not yourself, not someone who blocked you or you blocked", async () => {
      const { alice } = await trio();
      const dan = await signup(app, "dan");
      const item = await piece(alice);
      expect((await credit(alice, item, "dan")).body.error).toBe("You can only credit your friends");
      expect((await credit(alice, item, "alice")).body.error).toBe("You can't credit yourself");
      expect((await credit(alice, item, "nobody-here")).status).toBe(404);
      await befriend(alice, dan);
      await alice.agent.post("/api/users/dan/block");
      expect((await credit(alice, item, "dan")).status).toBe(400);
    });

    it("checks the role: needed, one line, at most 40 characters", async () => {
      const { alice } = await trio();
      const item = await piece(alice);
      for (const role of ["", "   ", undefined, 5, null, {}, "x".repeat(41)]) {
        const res = await alice.agent.post(`/api/credits/for/${item._id}`).send({ username: "bob", role });
        expect(res.status, JSON.stringify(role)).toBe(400);
      }
      expect((await credit(alice, item, "bob", "x".repeat(40))).status).toBe(201);
      expect((await alice.agent.post(`/api/credits/for/${item._id}`).send({ role: "x" })).status).toBe(400);
    });

    it("credits a person once per piece, and at most ten people per piece", async () => {
      const { alice } = await trio();
      const item = await piece(alice);
      expect((await credit(alice, item, "bob")).status).toBe(201);
      expect((await credit(alice, item, "bob", "Producer")).status).toBe(409);
      for (let i = 0; i < 9; i++) {
        const p = await signup(app, `pal${i}`);
        await befriend(alice, p);
        expect((await credit(alice, item, `pal${i}`)).status).toBe(201);
      }
      const last = await signup(app, "toomany");
      await befriend(alice, last);
      const over = await credit(alice, item, "toomany");
      expect(over.status).toBe(400);
      expect(over.body.error).toMatch(/up to 10 people/);
    });
  });

  describe("answering", () => {
    it("counts once the person accepts, and the owner is told", async () => {
      const { alice, bob } = await trio();
      const item = await piece(alice);
      const made = await credit(alice, item, "bob");
      const id = made.body.credit.id;
      expect((await alice.agent.post(`/api/credits/${id}/accept`)).status).toBe(404); // the owner can't accept on their behalf
      const ok = await bob.agent.post(`/api/credits/${id}/accept`);
      expect(ok.status).toBe(200);
      expect(ok.body.credit.status).toBe("accepted");
      expect(await Notification.countDocuments({ recipient: alice.user.id, type: "credit_accepted" })).toBe(1);
      expect(await Notification.countDocuments({ type: "credit_request" })).toBe(0); // the request is cleared
      await bob.agent.post(`/api/credits/${id}/accept`); // saying yes twice changes nothing
      expect(await Notification.countDocuments({ type: "credit_accepted" })).toBe(1);
    });

    it("lets the person see what is waiting for them, and no one else's", async () => {
      const { alice, bob, cara } = await trio();
      const item = await piece(alice);
      await credit(alice, item, "bob", "Producer");
      const mine = await bob.agent.get("/api/credits/mine");
      expect(mine.body.requests).toHaveLength(1);
      expect(mine.body.requests[0]).toMatchObject({ role: "Producer", owner: { username: "alice" } });
      expect((await cara.agent.get("/api/credits/mine")).body.requests).toHaveLength(0);
      expect((await request(app).get("/api/credits/mine")).status).toBe(401);
    });

    it("can be said no to, or taken back, by the owner or the person; a stranger can do neither", async () => {
      const { alice, bob, cara } = await trio();
      const item = await piece(alice);
      const first = (await credit(alice, item, "bob")).body.credit.id;
      expect((await cara.agent.delete(`/api/credits/${first}`)).status).toBe(404);
      expect((await bob.agent.delete(`/api/credits/${first}`)).status).toBe(204); // declining
      expect(await Notification.countDocuments({ type: "credit_request" })).toBe(0);
      const second = (await credit(alice, item, "bob")).body.credit.id;
      await bob.agent.post(`/api/credits/${second}/accept`);
      expect((await alice.agent.delete(`/api/credits/${second}`)).status).toBe(204); // the owner takes it off
      expect(await Credit.countDocuments()).toBe(0);
      expect((await request(app).delete(`/api/credits/${second}`)).status).toBe(401);
    });
  });

  describe("showing", () => {
    it("shows accepted credits on the piece to everyone, and waiting ones only to the owner and the person asked", async () => {
      const { alice, bob, cara } = await trio();
      const item = await piece(alice);
      const toBob = (await credit(alice, item, "bob", "Producer")).body.credit.id;
      await credit(alice, item, "cara", "Model");
      expect((await creditsOn(alice, "alice", item)).map((c) => c.status).sort()).toEqual(["pending", "pending"]);
      expect((await creditsOn(bob, "alice", item)).map((c) => c.user.username)).toEqual(["bob"]);
      expect(await creditsOn(null, "alice", item)).toEqual([]);
      await bob.agent.post(`/api/credits/${toBob}/accept`);
      expect((await creditsOn(null, "alice", item)).map((c) => `${c.user.username}:${c.role}`)).toEqual(["bob:Producer"]);
      expect((await creditsOn(cara, "alice", item)).map((c) => c.user.username).sort()).toEqual(["bob", "cara"]); // her own waiting one, and bob's accepted one
    });

    it("lists a person's collaborations on other people's pieces, only accepted ones", async () => {
      const { alice, bob } = await trio();
      const one = await piece(alice, 1);
      const two = await piece(alice, 2);
      const a = (await credit(alice, one, "bob", "Producer")).body.credit.id;
      await credit(alice, two, "bob", "Editor");
      await bob.agent.post(`/api/credits/${a}/accept`);
      const list = (await request(app).get("/api/credits/user/bob")).body.collaborations;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ role: "Producer", owner: { username: "alice" }, item: { id: String(one._id) } });
    });

    it("hides collaborations on a private profile from strangers, and from anyone blocked", async () => {
      const { alice, bob } = await trio();
      const dan = await signup(app, "dan");
      const item = await piece(alice);
      const id = (await credit(alice, item, "bob")).body.credit.id;
      await bob.agent.post(`/api/credits/${id}/accept`);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await dan.agent.get("/api/credits/user/bob")).body.collaborations).toEqual([]);
      expect((await bob.agent.get("/api/credits/user/bob")).body.collaborations).toHaveLength(1);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: false });
      await alice.agent.post("/api/users/dan/block");
      expect((await dan.agent.get("/api/credits/user/bob")).body.collaborations).toEqual([]);
    });

    it("leaves a blocked person out of the credits on a piece", async () => {
      const { alice, bob, cara } = await trio();
      const item = await piece(alice);
      const id = (await credit(alice, item, "bob")).body.credit.id;
      await bob.agent.post(`/api/credits/${id}/accept`);
      expect((await creditsOn(cara, "alice", item)).map((c) => c.user.username)).toEqual(["bob"]);
      await cara.agent.post("/api/users/bob/block");
      expect(await creditsOn(cara, "alice", item)).toEqual([]);
    });

    it("never gives away a suspended person", async () => {
      const { alice, bob, cara } = await trio();
      const item = await piece(alice);
      const id = (await credit(alice, item, "bob")).body.credit.id;
      await bob.agent.post(`/api/credits/${id}/accept`);
      await User.updateOne({ _id: bob.user.id }, { suspendedAt: new Date() });
      expect(await creditsOn(cara, "alice", item)).toEqual([]);
    });
  });

  describe("when things go away", () => {
    it("removes the credits, and the notices about them, when the piece is deleted", async () => {
      const { alice, bob } = await trio();
      const item = await piece(alice);
      await credit(alice, item, "bob");
      expect((await alice.agent.delete(`/api/media/${item._id}`)).status).toBe(204);
      expect(await Credit.countDocuments()).toBe(0);
      expect(await Notification.countDocuments({ type: "credit_request" })).toBe(0);
      expect((await bob.agent.get("/api/credits/mine")).body.requests).toEqual([]);
    });

    it("removes a person's credits, both ways, when their account is deleted", async () => {
      const { alice, bob, cara } = await trio();
      const mine = await piece(alice);
      const theirs = await piece(bob, 2);
      await credit(alice, mine, "bob");
      await credit(bob, theirs, "cara");
      const del = await bob.agent.delete("/api/profiles/me").send({ password: "password123" });
      expect(del.status).toBe(204);
      expect(await Credit.countDocuments()).toBe(0);
      expect(await creditsOn(cara, "alice", mine)).toEqual([]);
    });

    it("is part of what a person can download", async () => {
      const { alice, bob } = await trio();
      const item = await piece(alice);
      const id = (await credit(alice, item, "bob", "Producer")).body.credit.id;
      await bob.agent.post(`/api/credits/${id}/accept`);
      const { buildExport } = await import("../services/dataExport.js");
      const mine = await buildExport(alice.user.id);
      expect(mine.portfolio.creditsYouGave).toEqual([expect.objectContaining({ person: "bob", role: "Producer", accepted: true })]);
      const theirs = await buildExport(bob.user.id);
      expect(theirs.portfolio.creditsYouAccepted).toEqual([expect.objectContaining({ pieceOf: "alice", role: "Producer" })]);
    });
  });
});
