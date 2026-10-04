import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { activityBucket, activityFor, ONLINE_MS, TODAY_MS, WEEK_MS } from "../utils/activity.js";

let signups = 0;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.105.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  if (extra.private) await agent.patch("/api/profiles/me").send({ isPrivate: true });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("activityBucket", () => {
  const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
  const ago = (ms) => new Date(NOW - ms);
  it("is online within five minutes, then today, then this week, then nothing", () => {
    expect(activityBucket({ lastActiveAt: ago(30_000) }, NOW)).toBe("online");
    expect(activityBucket({ lastActiveAt: ago(ONLINE_MS - 1) }, NOW)).toBe("online");
    expect(activityBucket({ lastActiveAt: ago(ONLINE_MS) }, NOW)).toBe("today");
    expect(activityBucket({ lastActiveAt: ago(TODAY_MS - 1) }, NOW)).toBe("today");
    expect(activityBucket({ lastActiveAt: ago(TODAY_MS) }, NOW)).toBe("week");
    expect(activityBucket({ lastActiveAt: ago(WEEK_MS - 1) }, NOW)).toBe("week");
    expect(activityBucket({ lastActiveAt: ago(WEEK_MS) }, NOW)).toBeNull();
  });
  it("is nothing when unknown or turned off, and copes with a clock a little ahead", () => {
    expect(activityBucket({ lastActiveAt: null }, NOW)).toBeNull();
    expect(activityBucket({}, NOW)).toBeNull();
    expect(activityBucket(null, NOW)).toBeNull();
    expect(activityBucket({ lastActiveAt: ago(30_000), showActivity: false }, NOW)).toBeNull();
    expect(activityBucket({ lastActiveAt: new Date(NOW + 5_000) }, NOW)).toBe("online");
  });
});

describe("activityFor", () => {
  const user = { _id: "u1", lastActiveAt: new Date(), showActivity: true };
  it("is for friends only, and never for yourself or a visitor", () => {
    expect(activityFor(user, "v1", true)).toEqual({ activity: "online" });
    expect(activityFor(user, "v1", false)).toEqual({});
    expect(activityFor(user, undefined, true)).toEqual({});
    expect(activityFor(user, "u1", true)).toEqual({});
  });
});

describe("online now and last active", () => {
  let app, User;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ User } = await import("../models/User.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const ping = (who) => who.agent.post("/api/activity/ping");
  const lastActive = async (who) => (await User.findById(who.user.id)).lastActiveAt;
  const setLast = (who, msAgo) => User.updateOne({ _id: who.user.id }, { $set: { lastActiveAt: new Date(Date.now() - msAgo) } });
  const profileSeenBy = async (viewer, name) => (await viewer.agent.get(`/api/profiles/${name}`)).body.user;

  describe("checking in", () => {
    it("needs a sign-in", async () => {
      expect((await request(app).post("/api/activity/ping")).status).toBe(401);
    });

    it("records when someone was last active, at most once a minute", async () => {
      const alice = await signup(app, "alice");
      expect(await lastActive(alice)).toBeNull();
      expect((await ping(alice)).status).toBe(204);
      const first = await lastActive(alice);
      expect(first).toBeInstanceOf(Date);
      await ping(alice);
      expect((await lastActive(alice)).getTime()).toBe(first.getTime()); // too soon to write again
      await setLast(alice, 2 * 60_000);
      await ping(alice);
      expect(Date.now() - (await lastActive(alice)).getTime()).toBeLessThan(10_000);
    });
  });

  describe("who sees it", () => {
    it("shows friends 'online', in the profile, the friends list and the conversations", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      await ping(alice);
      expect((await profileSeenBy(bob, "alice")).activity).toBe("online");
      expect((await bob.agent.get("/api/friends")).body.friends[0].activity).toBe("online");
      expect((await bob.agent.get("/api/messages/conversations")).body.conversations[0].user.activity).toBe("online");
      expect((await bob.agent.get("/api/messages/with/alice")).body.user.activity).toBe("online");
    });

    it("rounds it to online, today or this week, and shows nothing for longer ago, and never the time itself", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      for (const [msAgo, expected] of [[60_000, "online"], [3 * 3600_000, "today"], [3 * 86_400_000, "week"], [9 * 86_400_000, undefined]]) {
        await setLast(alice, msAgo);
        const seen = await profileSeenBy(bob, "alice");
        expect(seen.activity, `${msAgo}ms ago`).toBe(expected);
        expect(JSON.stringify(seen)).not.toContain("lastActiveAt");
      }
    });

    it("shows nothing for someone who has never checked in", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      expect("activity" in (await profileSeenBy(bob, "alice"))).toBe(false);
    });

    it("shows nothing to strangers, people who only asked, visitors who aren't signed in, or someone you blocked", async () => {
      const alice = await signup(app, "alice");
      const cara = await signup(app, "carah");
      const dan = await signup(app, "daniel");
      await ping(alice);
      expect("activity" in (await profileSeenBy(cara, "alice"))).toBe(false);
      await dan.agent.post("/api/friends/request/alice"); // pending
      expect("activity" in (await profileSeenBy(dan, "alice"))).toBe(false);
      expect("activity" in (await request(app).get("/api/profiles/alice")).body.user).toBe(false);
      const search = (await cara.agent.get("/api/profiles?search=alice")).body.users[0];
      expect("activity" in search).toBe(false);
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      await bob.agent.post("/api/users/alice/block");
      expect((await bob.agent.get("/api/profiles/alice")).status).toBe(403);
    });

    it("doesn't show a person their own, but tells them whether it is on", async () => {
      const alice = await signup(app, "alice");
      await ping(alice);
      const me = await profileSeenBy(alice, "alice");
      expect("activity" in me).toBe(false);
      expect(me.showActivity).toBe(true);
    });

    it("doesn't tell other people whether it is on", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      expect("showActivity" in (await profileSeenBy(bob, "alice"))).toBe(false);
    });
  });

  describe("turning it off", () => {
    it("hides it from friends, forgets when they were last active, and stops recording", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      await ping(alice);
      expect((await profileSeenBy(bob, "alice")).activity).toBe("online");

      const off = await alice.agent.patch("/api/profiles/me").send({ showActivity: false });
      expect(off.status).toBe(200);
      expect(off.body.user.showActivity).toBe(false);
      expect(await lastActive(alice)).toBeNull();
      expect("activity" in (await profileSeenBy(bob, "alice"))).toBe(false);
      expect("activity" in (await bob.agent.get("/api/friends")).body.friends[0]).toBe(false);

      await ping(alice);
      expect(await lastActive(alice)).toBeNull();

      await alice.agent.patch("/api/profiles/me").send({ showActivity: true });
      await ping(alice);
      expect((await profileSeenBy(bob, "alice")).activity).toBe("online");
    });

    it("only accepts true or false, and changes nothing otherwise", async () => {
      const alice = await signup(app, "alice");
      for (const showActivity of ["no", 0, null, [], { a: 1 }]) {
        expect((await alice.agent.patch("/api/profiles/me").send({ bio: "nope", showActivity })).status, JSON.stringify(showActivity)).toBe(400);
      }
      expect((await profileSeenBy(alice, "alice")).showActivity).toBe(true);
      expect((await profileSeenBy(alice, "alice")).bio).not.toBe("nope");
    });

    it("is on for accounts made before the setting existed", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      await User.collection.updateOne({ username: "alice" }, { $unset: { showActivity: "" }, $set: { lastActiveAt: new Date() } });
      expect((await profileSeenBy(bob, "alice")).activity).toBe("online");
      expect((await profileSeenBy(alice, "alice")).showActivity).toBe(true);
    });
  });
});
