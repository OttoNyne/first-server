import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.106.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  if (extra.private) await agent.patch("/api/profiles/me").send({ isPrivate: true });
  if (extra.views) await agent.patch("/api/profiles/me").send({ profileViews: true });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("opt-in profile views", () => {
  let app, ProfileView, User;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ ProfileView } = await import("../models/ProfileView.js"));
    ({ User } = await import("../models/User.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const visit = (viewer, name) => viewer.agent.post(`/api/profile-views/${name}`);
  const visitors = async (who) => (await who.agent.get("/api/profile-views")).body.visitors;
  const rows = () => ProfileView.countDocuments();

  it("needs a sign-in", async () => {
    expect((await request(app).get("/api/profile-views")).status).toBe(401);
    expect((await request(app).post("/api/profile-views/alice")).status).toBe(401);
  });

  describe("consent from both people", () => {
    it("is off by default, for everyone", async () => {
      const alice = await signup(app, "alice");
      expect(alice.user.profileViews).toBe(false);
      const res = await alice.agent.get("/api/profile-views");
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("profile_views_off");
    });

    it("shows the owner a visitor only when both of them have turned it on", async () => {
      const owner = await signup(app, "owner", { views: true });
      const both = await signup(app, "bothon", { views: true });
      await visit(both, "owner");
      expect((await visitors(owner)).map((v) => v.user.username)).toEqual(["bothon"]);
    });

    it("records nothing for a visitor who hasn't turned it on", async () => {
      const owner = await signup(app, "owner", { views: true });
      const shy = await signup(app, "shyone");
      expect((await visit(shy, "owner")).status).toBe(204);
      expect(await rows()).toBe(0);
      expect(await visitors(owner)).toEqual([]);
    });

    it("records nothing for an owner who hasn't turned it on, and doesn't reveal it later when they do", async () => {
      const owner = await signup(app, "owner");
      const open = await signup(app, "openone", { views: true });
      await visit(open, "owner");
      expect(await rows()).toBe(0);
      await owner.agent.patch("/api/profiles/me").send({ profileViews: true });
      expect(await visitors(owner)).toEqual([]);
    });

    it("answers a visit the same way whatever the reason, so it reveals nothing about the owner", async () => {
      const on = await signup(app, "owneron", { views: true });
      const off = await signup(app, "ownerof");
      const priv = await signup(app, "private1", { views: true, private: true });
      const open = await signup(app, "openone", { views: true });
      for (const name of ["owneron", "ownerof", "private1", "nobody", "openone", "OWNERON"]) {
        const res = await visit(open, name);
        expect(res.status, name).toBe(204);
        expect(res.text, name).toBe("");
      }
      expect(on && off && priv).toBeTruthy();
    });

    it("never records a visit to your own profile", async () => {
      const alice = await signup(app, "alice", { views: true });
      await visit(alice, "alice");
      expect(await rows()).toBe(0);
    });
  });

  describe("who can be seen visiting", () => {
    it("doesn't record a visit to a profile you can't see (private and not a friend), and does for a friend", async () => {
      const owner = await signup(app, "owner", { views: true, private: true });
      const stranger = await signup(app, "stranger", { views: true });
      const friend = await signup(app, "friendly", { views: true });
      await befriend(owner, friend);
      await visit(stranger, "owner");
      expect(await visitors(owner)).toEqual([]);
      await visit(friend, "owner");
      expect((await visitors(owner)).map((v) => v.user.username)).toEqual(["friendly"]);
    });

    it("doesn't record a visit between people who have blocked each other, and hides a visitor you block afterwards", async () => {
      const owner = await signup(app, "owner", { views: true });
      const a = await signup(app, "aaron", { views: true });
      const b = await signup(app, "bella", { views: true });
      await b.agent.post("/api/users/owner/block");
      await visit(b, "owner");
      expect(await rows()).toBe(0);
      await visit(a, "owner");
      expect((await visitors(owner)).map((v) => v.user.username)).toEqual(["aaron"]);
      await owner.agent.post("/api/users/aaron/block");
      expect(await visitors(owner)).toEqual([]);
    });

    it("stops showing a visitor who turns it off afterwards, and forgets their visits", async () => {
      const owner = await signup(app, "owner", { views: true });
      const v = await signup(app, "visitor", { views: true });
      await visit(v, "owner");
      expect(await visitors(owner)).toHaveLength(1);
      await v.agent.patch("/api/profiles/me").send({ profileViews: false });
      expect(await visitors(owner)).toEqual([]);
      expect(await rows()).toBe(0);
    });

    it("forgets everything about visits to you when you turn it off, and the list is closed to you", async () => {
      const owner = await signup(app, "owner", { views: true });
      const v = await signup(app, "visitor", { views: true });
      await visit(v, "owner");
      await owner.agent.patch("/api/profiles/me").send({ profileViews: false });
      expect(await rows()).toBe(0);
      expect((await owner.agent.get("/api/profile-views")).status).toBe(403);
    });

    it("keeps the visits when a request that also turns it off is refused", async () => {
      const owner = await signup(app, "owner", { views: true });
      const v = await signup(app, "visitor", { views: true });
      await visit(v, "owner");
      const res = await owner.agent.patch("/api/profiles/me").send({ profileViews: false, bio: "x".repeat(1001) });
      expect(res.status).toBe(400);
      expect(await rows()).toBe(1);
      expect((await owner.agent.get("/api/profiles/owner")).body.user.profileViews).toBe(true);
    });
  });

  describe("what is shown", () => {
    it("lists each visitor once, newest first, with the day and never the time", async () => {
      const owner = await signup(app, "owner", { views: true });
      const one = await signup(app, "firstone", { views: true });
      const two = await signup(app, "secondon", { views: true });
      await visit(one, "owner");
      await visit(two, "owner");
      await visit(one, "owner"); // same visit within half an hour
      await ProfileView.updateOne({ viewer: one.user.id }, { $set: { lastViewedAt: new Date(Date.now() - 3 * 3600_000) } });
      await visit(one, "owner"); // a new visit: moves up
      const list = await visitors(owner);
      expect(list.map((v) => v.user.username)).toEqual(["firstone", "secondon"]);
      expect(list[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(list.every((v) => Object.keys(v).sort().join() === "day,user")).toBe(true); // a day and a person, no visit time
      expect(JSON.stringify(list)).not.toContain("lastViewedAt");
      expect(await rows()).toBe(2);
    });

    it("doesn't move a visit up for a second look within half an hour", async () => {
      const owner = await signup(app, "owner", { views: true });
      const v = await signup(app, "visitor", { views: true });
      await visit(v, "owner");
      const first = (await ProfileView.findOne({ viewer: v.user.id })).lastViewedAt.getTime();
      await visit(v, "owner");
      expect((await ProfileView.findOne({ viewer: v.user.id })).lastViewedAt.getTime()).toBe(first);
      expect(owner).toBeTruthy();
    });

    it("keeps a visit for 30 days and doesn't show an expired one", async () => {
      const owner = await signup(app, "owner", { views: true });
      const v = await signup(app, "visitor", { views: true });
      await visit(v, "owner");
      const row = await ProfileView.findOne({ viewer: v.user.id });
      const days = (row.expireAt - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30);
      await ProfileView.updateOne({ _id: row._id }, { $set: { expireAt: new Date(Date.now() - 1000) } });
      expect(await visitors(owner)).toEqual([]);
    });

    it("shows at most 50", async () => {
      const owner = await signup(app, "owner", { views: true });
      const ids = [];
      for (let i = 0; i < 52; i++) {
        const u = await User.create({ email: `v${i}@example.com`, username: `vv${i}`, passwordHash: "x", displayName: `V${i}`, profileViews: true });
        ids.push(u._id);
      }
      await ProfileView.insertMany(ids.map((viewer, i) => ({ owner: owner.user.id, viewer, lastViewedAt: new Date(Date.now() - i * 1000), expireAt: new Date(Date.now() + 1e9) })));
      expect(await visitors(owner)).toHaveLength(50);
    });

    it("doesn't expose the setting of other people, or visits, on profiles", async () => {
      const owner = await signup(app, "owner", { views: true });
      const other = await signup(app, "someone", { views: true });
      await visit(other, "owner");
      const seen = (await other.agent.get("/api/profiles/owner")).body.user;
      expect("profileViews" in seen).toBe(false);
      expect((await owner.agent.get("/api/profiles/owner")).body.user.profileViews).toBe(true);
    });
  });

  describe("the setting and the account", () => {
    it("only accepts true or false, and changes nothing otherwise", async () => {
      const alice = await signup(app, "alice");
      for (const profileViews of ["yes", 1, null, [], { a: 1 }]) {
        expect((await alice.agent.patch("/api/profiles/me").send({ bio: "nope", profileViews })).status, JSON.stringify(profileViews)).toBe(400);
      }
      const me = (await alice.agent.get("/api/profiles/alice")).body.user;
      expect(me.profileViews).toBe(false);
      expect(me.bio).not.toBe("nope");
    });

    it("is off for accounts made before the setting existed", async () => {
      const alice = await signup(app, "alice");
      await User.collection.updateOne({ username: "alice" }, { $unset: { profileViews: "" } });
      expect((await alice.agent.get("/api/profiles/alice")).body.user.profileViews).toBe(false);
      expect((await alice.agent.get("/api/profile-views")).status).toBe(403);
    });

    it("goes with the account: visits to it and visits it made", async () => {
      const owner = await signup(app, "owner", { views: true });
      const v = await signup(app, "visitor", { views: true });
      await visit(v, "owner");
      await visit(owner, "visitor");
      expect(await rows()).toBe(2);
      expect((await v.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await rows()).toBe(0);
    });
  });
});
