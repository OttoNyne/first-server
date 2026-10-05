import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${240 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user, name };
}

const DAY = 24 * 60 * 60 * 1000;

describe("the CSverified badge", () => {
  let app, M, S;
  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "boss@example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      Friendship: (await import("../models/Friendship.js")).Friendship,
      Notification: (await import("../models/Notification.js")).Notification,
      ModerationAction: (await import("../models/ModerationAction.js")).ModerationAction,
    };
    S = await import("../services/csVerified.js");
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    await clearTestDb();
    await disconnectTestDb();
  });

  async function makeAdmin() {
    const boss = await signup(app, "boss");
    await M.User.updateOne({ _id: boss.user.id }, { $set: { emailVerified: true } });
    return boss;
  }
  const profileOf = async (viewer, username) => (await viewer.agent.get(`/api/profiles/${username}`)).body.user;
  const notesOf = async (who) => (await who.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "cs_verified");
  const give = (admin, username) => admin.agent.put(`/api/admin/verified/${username}`);
  const take = (admin, username) => admin.agent.delete(`/api/admin/verified/${username}`);

  describe("given by an administrator", () => {
    it("is for administrators only", async () => {
      const boss = await signup(app, "boss"); // listed, but the address isn't confirmed
      const vee = await signup(app, "vee");
      for (const call of [() => give(boss, "vee"), () => take(boss, "vee"), () => boss.agent.get("/api/admin/verified")]) expect((await call()).status).toBe(404);
      expect((await request(app).put("/api/admin/verified/vee")).status).toBe(401);
      expect((await request(app).get("/api/admin/verified")).status).toBe(401);
      expect((await give(vee, "vee")).status).toBe(404);
      expect((await profileOf(vee, "vee")).csVerified).toBe(false);
    });

    it("shows on the profile, in search and on a private card, tells the person once, and is recorded", async () => {
      const boss = await makeAdmin();
      const vee = await signup(app, "vee");
      const viewer = await signup(app, "viewer");
      expect((await profileOf(viewer, "vee")).csVerified).toBe(false);

      const res = await give(boss, "vee");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ given: true, user: { username: "vee", csVerified: true } });
      expect((await profileOf(viewer, "vee")).csVerified).toBe(true);
      expect((await viewer.agent.get("/api/search?q=vee")).body.results[0].csVerified).toBe(true);
      expect((await viewer.agent.get("/api/profiles?search=vee")).body.users[0].csVerified).toBe(true);

      // a private profile's restricted card still shows it: being verified is public
      await vee.agent.patch("/api/profiles/me").send({ isPrivate: true });
      const card = (await viewer.agent.get("/api/search?q=vee")).body.results[0];
      expect(card.bio).toBeUndefined();
      expect(card.csVerified).toBe(true);

      expect(await notesOf(vee)).toHaveLength(1);
      expect((await notesOf(vee))[0].payload).toEqual({ reason: "admin" });
      const record = await M.ModerationAction.find({ action: "verified" });
      expect(record).toHaveLength(1);
      expect(String(record[0].admin)).toBe(boss.user.id);
      expect(String(record[0].subject)).toBe(vee.user.id);
      expect((await boss.agent.get("/api/admin/actions")).body.actions[0]).toMatchObject({ action: "verified", reportCount: 0 });

      // giving it again changes nothing: no second note, no second record
      const again = await give(boss, "vee");
      expect(again.body.given).toBe(false);
      expect(await notesOf(vee)).toHaveLength(1);
      expect(await M.ModerationAction.countDocuments({ action: "verified" })).toBe(1);
    });

    it("finds the person by username however it is written, and refuses what can't be given", async () => {
      const boss = await makeAdmin();
      const vee = await signup(app, "vee");
      expect((await give(boss, "nobody")).status).toBe(404);
      expect((await give(boss, "nobody")).body.error).toBe("No one has that username");
      expect((await give(boss, "%40VEE")).body.given).toBe(true); // "@VEE"
      await M.User.updateOne({ _id: vee.user.id }, { $set: { suspendedAt: new Date() } });
      const gone = await signup(app, "gone");
      await M.User.updateOne({ _id: gone.user.id }, { $set: { suspendedAt: new Date() } });
      const res = await give(boss, "gone");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("That account is suspended");
      expect((await M.User.findById(gone.user.id)).csVerifiedByAdmin).toBe(false);
    });

    it("can be taken away, once, and that is recorded; everyone then sees no badge", async () => {
      const boss = await makeAdmin();
      const vee = await signup(app, "vee");
      expect((await take(boss, "vee")).status).toBe(404); // nothing to take
      expect((await take(boss, "nobody")).status).toBe(404);
      await give(boss, "vee");
      expect((await take(boss, "vee")).status).toBe(204);
      expect((await profileOf(vee, "vee")).csVerified).toBe(false);
      expect(await M.ModerationAction.countDocuments({ action: "unverified" })).toBe(1);
      expect((await take(boss, "vee")).status).toBe(404);
      expect(await M.ModerationAction.countDocuments({ action: "unverified" })).toBe(1);
    });

    it("lists the people given it, newest first, twenty a page, and not those who earned it", async () => {
      const boss = await makeAdmin();
      expect((await boss.agent.get("/api/admin/verified")).body).toEqual({ users: [], page: 1, hasMore: false });
      const { User } = M;
      const earlier = new Date(Date.now() - 5 * DAY);
      await User.insertMany(Array.from({ length: 22 }, (_, i) => ({ email: `p${i}@example.com`, username: `person${String(i).padStart(2, "0")}`, displayName: `Person ${i}`, passwordHash: "x", csVerifiedByAdmin: true, csVerifiedAdminAt: new Date(earlier.getTime() + i * 1000) })));
      await User.create({ email: "earned@example.com", username: "earnedone", displayName: "Earned", passwordHash: "x", csVerifiedEarned: true });
      const one = (await boss.agent.get("/api/admin/verified")).body;
      expect(one.users).toHaveLength(20);
      expect(one.hasMore).toBe(true);
      expect(one.users[0].user.username).toBe("person21");
      expect(one.users[0].givenAt).toBeTruthy();
      const two = (await boss.agent.get("/api/admin/verified?page=2")).body;
      expect(two.users.map((u) => u.user.username)).toEqual(["person01", "person00"]);
      expect(JSON.stringify(one)).not.toContain("earnedone");
    });

    it("can't be set by the person themselves, in a profile edit or at sign-up", async () => {
      const vee = await signup(app, "vee");
      await vee.agent.patch("/api/profiles/me").send({ csVerified: true, csVerifiedByAdmin: true, csVerifiedEarned: true, bio: "hi" });
      const row = await M.User.findById(vee.user.id);
      expect([row.csVerifiedByAdmin, row.csVerifiedEarned]).toEqual([false, false]);
      const sneaky = await request(app).post("/api/auth/register").set("x-vercel-forwarded-for", "198.51.99.9").send({ email: "sneaky@example.com", username: "sneaky", password: "password123", displayName: "Sneaky", csVerifiedByAdmin: true, csVerified: true });
      expect(sneaky.status).toBe(201);
      expect(sneaky.body.user.csVerified).toBe(false);
      expect((await M.User.findOne({ username: "sneaky" })).csVerifiedByAdmin).toBe(false);
    });
  });

  describe("earned with 1,000 active friends", () => {
    // A person with `n` friends who count, plus one of each kind that doesn't: unconfirmed, suspended, quiet for 31 days, never
    // shares when they are active. Everyone is a real friendship (accepted), so only "active" tells them apart.
    async function withFriends(n) {
      const me = await signup(app, "mimi");
      const now = new Date();
      const make = (kind, i, extra = {}) => ({ email: `${kind}${i}@example.com`, username: `${kind}${i}`, displayName: `${kind} ${i}`, passwordHash: "x", emailVerified: true, lastActiveAt: now, ...extra });
      const docs = [
        ...Array.from({ length: n }, (_, i) => make("act", i)),
        make("unconfirmed", 0, { emailVerified: false }),
        make("suspended", 0, { suspendedAt: now }),
        make("quiet", 0, { lastActiveAt: new Date(now.getTime() - 31 * DAY) }),
        make("hidden", 0, { lastActiveAt: null, showActivity: false }),
      ];
      const users = await M.User.insertMany(docs);
      await M.Friendship.insertMany(users.map((u) => ({ requester: me.user.id, addressee: u._id, status: "accepted" })));
      // asked but not accepted: not friends, so not counted
      const pending = await M.User.insertMany(Array.from({ length: 5 }, (_, i) => make("pending", i)));
      await M.Friendship.insertMany(pending.map((u) => ({ requester: u._id, addressee: me.user.id, status: "pending" })));
      return { me, active: users.slice(0, n).map((u) => u._id), all: users };
    }
    const makeQuiet = (ids) => M.User.updateMany({ _id: { $in: ids } }, { $set: { lastActiveAt: new Date(Date.now() - 40 * DAY) } });
    const makeActive = (ids) => M.User.updateMany({ _id: { $in: ids } }, { $set: { lastActiveAt: new Date() } });
    const shows = async (me) => (await profileOf(me, "mimi")).csVerified;

    it("counts only friends who are confirmed, not suspended, and seen in the last 30 days", { timeout: 120_000 }, async () => {
      const { me } = await withFriends(7);
      expect(await S.activeFriendCount(me.user.id)).toBe(7);
      expect(S.EARN_AT).toBe(1000);
      expect(S.KEEP_AT).toBe(900);
      expect(S.ACTIVE_DAYS).toBe(30);
      // thirty days is the edge: seen 29 days ago counts, seen 31 days ago doesn't
      const [one] = await M.User.find({ username: "act0" });
      await M.User.updateOne({ _id: one._id }, { $set: { lastActiveAt: new Date(Date.now() - 29 * DAY) } });
      expect(await S.activeFriendCount(me.user.id)).toBe(7);
      await M.User.updateOne({ _id: one._id }, { $set: { lastActiveAt: new Date(Date.now() - 31 * DAY) } });
      expect(await S.activeFriendCount(me.user.id)).toBe(6);
      // someone with no friends has none, and a block doesn't matter here: it is about who is friends
      expect(await S.activeFriendCount((await signup(app, "lonely")).user.id)).toBe(0);
    });

    it("is earned at 1,000, kept above 899 and lost below it, with one note when it is earned", { timeout: 300_000 }, async () => {
      const { me, active } = await withFriends(1000);
      const viewer = await signup(app, "viewer");
      const stale = active.slice(0, 1);
      await makeQuiet(stale);
      expect(await S.activeFriendCount(me.user.id)).toBe(999);
      expect(await S.evaluateEarned(me.user.id)).toBeNull();
      expect(await shows(viewer)).toBe(false);

      await makeActive(stale); // 1,000
      expect(await S.evaluateEarned(me.user.id)).toBe("earned");
      expect(await shows(viewer)).toBe(true);
      expect((await viewer.agent.get("/api/search?q=mimi")).body.results[0].csVerified).toBe(true);
      expect(await notesOf(me)).toHaveLength(1);
      expect((await notesOf(me))[0].payload).toEqual({ reason: "friends" });
      expect(await S.evaluateEarned(me.user.id)).toBeNull(); // nothing new, so no second note
      expect(await notesOf(me)).toHaveLength(1);

      await makeQuiet(active.slice(0, 100)); // 900: still kept
      expect(await S.activeFriendCount(me.user.id)).toBe(900);
      expect(await S.evaluateEarned(me.user.id)).toBeNull();
      expect(await shows(viewer)).toBe(true);
      await makeQuiet(active.slice(100, 101)); // 899: lost
      expect(await S.evaluateEarned(me.user.id)).toBe("lost");
      expect(await shows(viewer)).toBe(false);
      expect(await notesOf(me)).toHaveLength(1); // losing it isn't announced

      // it can be earned again, and tells them again
      await makeActive(active.slice(0, 101));
      expect(await S.evaluateEarned(me.user.id)).toBe("earned");
      expect(await notesOf(me)).toHaveLength(2);
    });

    it("is kept apart from an administrator's badge: neither takes the other away, and an administrator's means no note", { timeout: 300_000 }, async () => {
      const boss = await makeAdmin();
      const { me, active } = await withFriends(1000);
      const viewer = await signup(app, "viewer");
      await give(boss, "mimi");
      expect(await notesOf(me)).toHaveLength(1); // told once, for the administrator's
      expect(await S.evaluateEarned(me.user.id)).toBe("earned");
      expect(await notesOf(me)).toHaveLength(1); // already showing it, so nothing new to tell

      await take(boss, "mimi"); // the earned one stays
      expect(await shows(viewer)).toBe(true);
      await give(boss, "mimi");
      await makeQuiet(active.slice(0, 200)); // 800 active: the earned one goes, the administrator's stays
      expect(await S.evaluateEarned(me.user.id)).toBe("lost");
      expect(await shows(viewer)).toBe(true);
      await take(boss, "mimi");
      expect(await shows(viewer)).toBe(false);
    });

    it("looks at people with 900 friends or more, and anyone who holds an earned badge, and no one else", { timeout: 300_000 }, async () => {
      const { me, active } = await withFriends(1000);
      const bystander = await signup(app, "bystander");
      await M.Friendship.create({ requester: bystander.user.id, addressee: active[0], status: "accepted" });
      const holder = await signup(app, "holder");
      await M.User.updateOne({ _id: holder.user.id }, { $set: { csVerifiedEarned: true } });
      expect((await S.candidates()).sort()).toEqual([me.user.id, holder.user.id].sort());

      // everyone is checked; the holder has no friends, so loses it, and mimi earns it
      expect(await S.processCsVerified(new Date())).toEqual({ earned: 1, lost: 1 });
      expect(await shows(me)).toBe(true);
      expect((await profileOf(me, "holder")).csVerified).toBe(false);

      // the run that happens on its own is at most every six hours
      await makeQuiet(active.slice(0, 150)); // 850 active
      expect(await S.processCsVerified()).toEqual({ earned: 0, lost: 1 }); // the first run
      expect(await shows(me)).toBe(false);
      await makeActive(active.slice(0, 150));
      expect(await S.processCsVerified()).toEqual({ earned: 0, lost: 0 }); // too soon after the last
      expect(await shows(me)).toBe(false);
      expect(await S.processCsVerified(new Date())).toEqual({ earned: 1, lost: 0 }); // unless it is asked for at a time
      expect(await shows(me)).toBe(true);
    });

    it("never gives it to a suspended account, and one atomic update means it is announced once", { timeout: 300_000 }, async () => {
      const { me } = await withFriends(1000);
      await M.User.updateOne({ _id: me.user.id }, { $set: { suspendedAt: new Date() } });
      expect(await S.evaluateEarned(me.user.id)).toBeNull();
      await M.User.updateOne({ _id: me.user.id }, { $set: { suspendedAt: null } });
      const results = await Promise.all([S.evaluateEarned(me.user.id), S.evaluateEarned(me.user.id), S.evaluateEarned(me.user.id)]);
      expect(results.filter((r) => r === "earned")).toHaveLength(1);
      expect(await notesOf(me)).toHaveLength(1);
    });
  });
});
