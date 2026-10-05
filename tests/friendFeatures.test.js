import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${210 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user, name };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("friend features: mutual friends and people you may know", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      Friendship: (await import("../models/Friendship.js")).Friendship,
      DismissedSuggestion: (await import("../models/DismissedSuggestion.js")).DismissedSuggestion,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const mutual = (who, username) => who.agent.get(`/api/friends/mutual/${username}`);
  const suggested = async (who) => (await who.agent.get("/api/friends/suggestions")).body.suggestions;
  const names = (list) => list.map((s) => s.user.username).sort();

  describe("mutual friends", () => {
    it("shows the friends two people share, and how many", async () => {
      const me = await signup(app, "mimi");
      const zoe = await signup(app, "zoe");
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const solo = await signup(app, "solo");
      for (const f of [ann, bob]) {
        await befriend(me, f);
        await befriend(zoe, f);
      }
      await befriend(me, solo); // mine alone
      const res = await mutual(me, "zoe");
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.friends.map((f) => f.username).sort()).toEqual(["ann", "bobby"]);
      // the other way round it is the same two
      expect((await mutual(zoe, "mimi")).body.friends.map((f) => f.username).sort()).toEqual(["ann", "bobby"]);
    });

    it("shows at most eight, with the whole count", { timeout: 240_000 }, async () => {
      const me = await signup(app, "mimi");
      const zoe = await signup(app, "zoe");
      const shared = [];
      for (let i = 0; i < 10; i++) shared.push(await signup(app, `shared${i}`));
      // friendships directly: the people aren't the point
      await M.Friendship.insertMany(shared.flatMap((f) => [{ requester: me.user.id, addressee: f.user.id, status: "accepted" }, { requester: zoe.user.id, addressee: f.user.id, status: "accepted" }]));
      const res = await mutual(me, "zoe");
      expect(res.body.count).toBe(10);
      expect(res.body.friends).toHaveLength(8);
    });

    it("says nothing for yourself, for a stranger with nothing in common, or someone not found", async () => {
      const me = await signup(app, "mimi");
      const zoe = await signup(app, "zoe");
      expect((await mutual(me, "mimi")).body).toEqual({ count: 0, friends: [] });
      expect((await mutual(me, "zoe")).body).toEqual({ count: 0, friends: [] });
      expect((await mutual(me, "nobody")).status).toBe(404);
      expect(zoe).toBeTruthy();
    });

    it("needs a sign-in, and follows the profile's own visibility", async () => {
      const me = await signup(app, "mimi");
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      expect((await request(app).get("/api/friends/mutual/zoe")).status).toBe(401);
      await zoe.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await mutual(me, "zoe")).status).toBe(403); // private, not a friend
      await befriend(me, zoe);
      await befriend(kai, zoe);
      expect((await mutual(kai, "zoe")).status).toBe(200); // a friend may look
      await me.agent.post(`/api/users/${kai.user.username}/block`);
      expect((await mutual(me, "kai")).status).toBe(403);
      await M.User.updateOne({ _id: kai.user.id }, { $set: { suspendedAt: new Date() } });
      expect((await mutual(zoe, "kai")).status).toBe(404);
    });

    it("leaves out people who have switched connections off, and says nothing about someone who has", async () => {
      const me = await signup(app, "mimi");
      const zoe = await signup(app, "zoe");
      const ann = await signup(app, "ann");
      const shy = await signup(app, "shy");
      for (const f of [ann, shy]) {
        await befriend(me, f);
        await befriend(zoe, f);
      }
      expect((await mutual(me, "zoe")).body.count).toBe(2);
      await shy.agent.patch("/api/profiles/me").send({ showConnections: false });
      expect((await mutual(me, "zoe")).body.friends.map((f) => f.username)).toEqual(["ann"]);
      expect((await mutual(me, "zoe")).body.count).toBe(1);
      await zoe.agent.patch("/api/profiles/me").send({ showConnections: false });
      expect((await mutual(me, "zoe")).body).toEqual({ count: 0, friends: [] }); // zoe's friends are zoe's own
    });

    it("leaves out suspended people", async () => {
      const me = await signup(app, "mimi");
      const zoe = await signup(app, "zoe");
      const ann = await signup(app, "ann");
      await befriend(me, ann);
      await befriend(zoe, ann);
      await M.User.updateOne({ _id: ann.user.id }, { $set: { suspendedAt: new Date() } });
      expect((await mutual(me, "zoe")).body.count).toBe(0);
    });

    it("tells you how many friends each person asking to be your friend has in common with you", async () => {
      const me = await signup(app, "mimi");
      const stranger = await signup(app, "stranger");
      const quiet = await signup(app, "quiet");
      const ann = await signup(app, "ann");
      await befriend(me, ann);
      await befriend(stranger, ann);
      await befriend(quiet, ann);
      await stranger.agent.post("/api/friends/request/mimi");
      await quiet.agent.post("/api/friends/request/mimi");
      await quiet.agent.patch("/api/profiles/me").send({ showConnections: false });
      const requests = (await me.agent.get("/api/friends/requests")).body.requests;
      expect(Object.fromEntries(requests.map((r) => [r.requester.username, r.mutualCount]))).toEqual({ stranger: 1, quiet: 0 });
    });
  });

  describe("people you may know", () => {
    it("suggests friends of your friends, most in common first, with who you share", async () => {
      const me = await signup(app, "mimi");
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const popular = await signup(app, "popular");
      const lone = await signup(app, "lone");
      await befriend(me, ann);
      await befriend(me, bob);
      await befriend(popular, ann);
      await befriend(popular, bob);
      await befriend(lone, ann);
      const list = await suggested(me);
      expect(list.map((s) => s.user.username)).toEqual(["popular", "lone"]);
      expect(list[0].mutualCount).toBe(2);
      expect(list[0].mutual.map((m) => m.username).sort()).toEqual(["ann", "bobby"]);
      expect(list[1]).toMatchObject({ mutualCount: 1 });
      expect(list[1].mutual.map((m) => m.username)).toEqual(["ann"]);
    });

    it("suggests nobody to someone with no friends, and never yourself or your own friends", async () => {
      const me = await signup(app, "mimi");
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      expect(await suggested(me)).toEqual([]);
      await befriend(me, ann);
      await befriend(me, bob);
      await befriend(ann, bob); // already your friend: not a suggestion
      expect(await suggested(me)).toEqual([]);
    });

    it("leaves out anyone you already have a request with, in either direction, or a declined one", async () => {
      const me = await signup(app, "mimi");
      const ann = await signup(app, "ann");
      const sent = await signup(app, "sent");
      const got = await signup(app, "got");
      const declined = await signup(app, "declined");
      const fresh = await signup(app, "fresh");
      for (const p of [sent, got, declined, fresh]) await befriend(ann, p);
      await befriend(me, ann);
      await me.agent.post("/api/friends/request/sent");
      await got.agent.post("/api/friends/request/mimi");
      const asked = await me.agent.post("/api/friends/request/declined");
      await declined.agent.post(`/api/friends/decline/${asked.body.friendship._id}`);
      expect(names(await suggested(me))).toEqual(["fresh"]);
    });

    it("leaves out people blocked either way, suspended accounts and private profiles", async () => {
      const me = await signup(app, "mimi");
      const ann = await signup(app, "ann");
      const mine = await signup(app, "blockedbyme");
      const theirs = await signup(app, "blockedme");
      const suspended = await signup(app, "suspended");
      const hidden = await signup(app, "hidden");
      const fresh = await signup(app, "fresh");
      for (const p of [mine, theirs, suspended, hidden, fresh]) await befriend(ann, p);
      await befriend(me, ann);
      await me.agent.post(`/api/users/${mine.user.username}/block`);
      await theirs.agent.post(`/api/users/${me.user.username}/block`);
      await M.User.updateOne({ _id: suspended.user.id }, { $set: { suspendedAt: new Date() } });
      await hidden.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect(names(await suggested(me))).toEqual(["fresh"]);
    });

    it("respects people who have switched connections off: not suggested, and their friends aren't suggested through them", async () => {
      const me = await signup(app, "mimi");
      const ann = await signup(app, "ann");
      const quiet = await signup(app, "quiet"); // my friend, switched off
      const viaQuiet = await signup(app, "viaquiet");
      const shy = await signup(app, "shy"); // a friend of ann, switched off
      const open = await signup(app, "open");
      await befriend(me, ann);
      await befriend(me, quiet);
      await befriend(quiet, viaQuiet);
      await befriend(ann, shy);
      await befriend(ann, open);
      await quiet.agent.patch("/api/profiles/me").send({ showConnections: false });
      await shy.agent.patch("/api/profiles/me").send({ showConnections: false });
      expect(names(await suggested(me))).toEqual(["open"]);
    });

    it("leaves out anyone you said you aren't interested in, and remembers it", async () => {
      const me = await signup(app, "mimi");
      const ann = await signup(app, "ann");
      const one = await signup(app, "one");
      const two = await signup(app, "two");
      await befriend(me, ann);
      await befriend(ann, one);
      await befriend(ann, two);
      expect(names(await suggested(me))).toEqual(["one", "two"]);
      expect((await me.agent.post("/api/friends/suggestions/dismiss/one")).status).toBe(204);
      expect((await me.agent.post("/api/friends/suggestions/dismiss/one")).status).toBe(204); // again: nothing changes
      expect(names(await suggested(me))).toEqual(["two"]);
      expect(await M.DismissedSuggestion.countDocuments({ owner: me.user.id })).toBe(1);
      expect(names(await suggested(one))).toEqual(["mimi", "two"]); // what mimi dismissed doesn't change what others are shown
    });

    it("checks who is being dismissed, and how many are kept", { timeout: 120_000 }, async () => {
      const me = await signup(app, "mimi");
      const other = await signup(app, "other");
      expect((await me.agent.post("/api/friends/suggestions/dismiss/nobody")).status).toBe(404);
      expect((await me.agent.post("/api/friends/suggestions/dismiss/mimi")).status).toBe(400);
      expect((await request(app).post("/api/friends/suggestions/dismiss/other")).status).toBe(401);
      const ids = Array.from({ length: 500 }, () => new (M.User.base.Types.ObjectId)());
      await M.DismissedSuggestion.insertMany(ids.map((target) => ({ owner: me.user.id, target })));
      expect((await me.agent.post("/api/friends/suggestions/dismiss/other")).status).toBe(400);
      expect(other).toBeTruthy();
    });

    it("suggests at most twelve", { timeout: 240_000 }, async () => {
      const me = await signup(app, "mimi");
      const ann = await signup(app, "ann");
      await befriend(me, ann);
      const many = [];
      for (let i = 0; i < 14; i++) many.push(await signup(app, `cand${String(i).padStart(2, "0")}`));
      await M.Friendship.insertMany(many.map((p) => ({ requester: ann.user.id, addressee: p.user.id, status: "accepted" })));
      expect(await suggested(me)).toHaveLength(12);
    });

    it("needs a sign-in", async () => {
      expect((await request(app).get("/api/friends/suggestions")).status).toBe(401);
    });
  });

  describe("the switch", () => {
    it("is on for everyone to begin with, can be turned off and on by its owner, and must be true or false", async () => {
      const me = await signup(app, "mimi");
      expect(me.user.showConnections).toBe(true);
      expect((await me.agent.patch("/api/profiles/me").send({ showConnections: false })).body.user.showConnections).toBe(false);
      expect((await me.agent.get("/api/auth/me")).body.user.showConnections).toBe(false);
      for (const bad of ["no", 0, null, {}]) expect((await me.agent.patch("/api/profiles/me").send({ showConnections: bad })).status, JSON.stringify(bad)).toBe(400);
      expect((await me.agent.patch("/api/profiles/me").send({ showConnections: true })).body.user.showConnections).toBe(true);
    });

    it("is private to its owner: other people's views of a profile don't carry it", async () => {
      const me = await signup(app, "mimi");
      const zoe = await signup(app, "zoe");
      await zoe.agent.patch("/api/profiles/me").send({ showConnections: false });
      expect((await me.agent.get("/api/profiles/zoe")).body.user).not.toHaveProperty("showConnections");
    });
  });

  describe("when accounts go away", () => {
    it("forgets the suggestions someone dismissed, and the ones made about them", async () => {
      const me = await signup(app, "mimi");
      const ann = await signup(app, "ann");
      const one = await signup(app, "one");
      await befriend(me, ann);
      await befriend(ann, one);
      await me.agent.post("/api/friends/suggestions/dismiss/one");
      await one.agent.post("/api/friends/suggestions/dismiss/mimi");
      expect(await M.DismissedSuggestion.countDocuments()).toBe(2);
      expect((await one.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await M.DismissedSuggestion.countDocuments()).toBe(0);
    });
  });
});
