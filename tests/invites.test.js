import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
const nextIp = () => `198.51.${109 + Math.floor(signups / 250)}.${(signups % 250) + 1}`;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", nextIp()).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name, ...(extra.invite ? { invite: extra.invite } : {}) });
  if (extra.private) await agent.patch("/api/profiles/me").send({ isPrivate: true });
  return { agent, user: res.body.user, res };
}

describe("invite links", () => {
  let app, Invite, Friendship, Notification;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Invite } = await import("../models/Invite.js"));
    ({ Friendship } = await import("../models/Friendship.js"));
    ({ Notification } = await import("../models/Notification.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const makeInvite = (who) => who.agent.post("/api/invites");
  const preview = (code) => request(app).get(`/api/invites/preview/${code}`);
  const friendsOf = async (who) => (await who.agent.get("/api/friends")).body.friends.map((f) => f.username);

  describe("making and switching off", () => {
    it("needs a sign-in to make, list or switch off, but not to preview", async () => {
      expect((await request(app).post("/api/invites")).status).toBe(401);
      expect((await request(app).get("/api/invites")).status).toBe(401);
      expect((await request(app).delete("/api/invites/5f1d7f3b8f1d7f3b8f1d7f3b")).status).toBe(401);
      expect((await preview("nonsense12345")).status).toBe(404);
    });

    it("makes a link with an unguessable code, a week to live and ten places, and lists it", async () => {
      const alice = await signup(app, "alice");
      const res = await makeInvite(alice);
      expect(res.status).toBe(201);
      expect(res.body.invite.code).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(res.body.invite).toMatchObject({ uses: 0, maxUses: 10, joined: [] });
      const days = (new Date(res.body.invite.expiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);
      const other = await makeInvite(alice);
      expect(other.body.invite.code).not.toBe(res.body.invite.code);
      expect((await alice.agent.get("/api/invites")).body.invites).toHaveLength(2);
    });

    it("allows three links at once, and ten a day", async () => {
      const alice = await signup(app, "alice");
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push((await makeInvite(alice)).body.invite.id);
      expect((await makeInvite(alice)).status).toBe(400);
      expect(ids).toHaveLength(3);
      // switch every active link off, then make links until the daily limit
      await Invite.updateMany({}, { $set: { revokedAt: new Date() } });
      let made = 3;
      let last;
      while (made < 12) {
        last = await makeInvite(alice);
        if (last.status !== 201) break;
        await Invite.updateMany({}, { $set: { revokedAt: new Date() } });
        made++;
      }
      expect(made).toBe(10);
      expect(last.status).toBe(429);
      expect(last.headers["retry-after"]).toBeTruthy();
    });

    it("lets only the owner switch a link off, and answers others as if it didn't exist", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const inv = (await makeInvite(alice)).body.invite;
      expect((await bob.agent.delete(`/api/invites/${inv.id}`)).status).toBe(404);
      expect((await alice.agent.delete("/api/invites/not-an-id")).status).toBe(404);
      expect((await preview(inv.code)).status).toBe(200);
      expect((await alice.agent.delete(`/api/invites/${inv.id}`)).status).toBe(204);
      expect((await alice.agent.delete(`/api/invites/${inv.id}`)).status).toBe(404);
      expect((await preview(inv.code)).status).toBe(404);
      expect((await alice.agent.get("/api/invites")).body.invites).toEqual([]);
    });
  });

  describe("the preview", () => {
    it("shows who is inviting, and only their name, address and picture", async () => {
      const alice = await signup(app, "alice");
      const inv = (await makeInvite(alice)).body.invite;
      const res = await preview(inv.code);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.inviter).sort()).toEqual(["avatarUrl", "displayName", "username"]);
      expect(res.body.inviter.username).toBe("alice");
      expect(JSON.stringify(res.body)).not.toMatch(/email|createdAt|isPrivate/);
    });

    it("gives every reason a link can't be used the same answer", async () => {
      const alice = await signup(app, "alice");
      const revoked = (await makeInvite(alice)).body.invite;
      const expired = (await makeInvite(alice)).body.invite;
      const full = (await makeInvite(alice)).body.invite;
      await Invite.updateOne({ code: revoked.code }, { $set: { revokedAt: new Date() } });
      await Invite.updateOne({ code: expired.code }, { $set: { expireAt: new Date(Date.now() - 1000) } });
      await Invite.updateOne({ code: full.code }, { $set: { uses: 10 } });
      const answers = [];
      for (const code of [revoked.code, expired.code, full.code, "wrongcode123456", "x", "a".repeat(100), "bad code!"]) {
        const res = await preview(code);
        answers.push([res.status, JSON.stringify(res.body)]);
      }
      expect(new Set(answers.map((a) => a.join("|"))).size).toBe(1);
      expect(answers[0][0]).toBe(404);
    });

    it("is rate-limited so codes can't be guessed", async () => {
      let last;
      for (let i = 0; i < 61; i++) last = await preview("wrongcode123456").set("x-vercel-forwarded-for", "203.0.113.9");
      expect(last.status).toBe(429);
      expect(last.headers["retry-after"]).toBeTruthy();
    });
  });

  describe("signing up with a link", () => {
    it("makes them friends straight away, counts the use, tells the inviter, and says who invited them", async () => {
      const alice = await signup(app, "alice");
      const inv = (await makeInvite(alice)).body.invite;
      const bob = await signup(app, "bobby", { invite: inv.code });
      expect(bob.res.status).toBe(201);
      expect(bob.res.body.invitedBy).toBe("alice");
      expect(await friendsOf(alice)).toEqual(["bobby"]);
      expect(await friendsOf(bob)).toEqual(["alice"]);
      expect((await Friendship.findOne({})).status).toBe("accepted");
      const listed = (await alice.agent.get("/api/invites")).body.invites[0];
      expect(listed.uses).toBe(1);
      expect(listed.joined.map((j) => j.user.username)).toEqual(["bobby"]);
      const notes = (await alice.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "invite_joined");
      expect(notes).toHaveLength(1);
      expect(notes[0].actor.username).toBe("bobby");
    });

    it("still signs people up when the code is wrong, old, switched off or full, without making friends", async () => {
      const alice = await signup(app, "alice");
      const revoked = (await makeInvite(alice)).body.invite;
      const expired = (await makeInvite(alice)).body.invite;
      const full = (await makeInvite(alice)).body.invite;
      await Invite.updateOne({ code: revoked.code }, { $set: { revokedAt: new Date() } });
      await Invite.updateOne({ code: expired.code }, { $set: { expireAt: new Date(Date.now() - 1000) } });
      await Invite.updateOne({ code: full.code }, { $set: { uses: 10 } });
      let n = 0;
      for (const code of [revoked.code, expired.code, full.code, "wrongcode123456", "bad code!", "a".repeat(64)]) {
        const p = await signup(app, `person${++n}`, { invite: code });
        expect(p.res.status, code).toBe(201);
        expect("invitedBy" in p.res.body, code).toBe(false);
      }
      expect(await Friendship.countDocuments()).toBe(0);
      expect((await Invite.findOne({ code: full.code })).uses).toBe(10);
    });

    it("rejects a code that is too long to be one", async () => {
      const p = await signup(app, "toolong", { invite: "x".repeat(65) });
      expect(p.res.status).toBe(400);
    });

    it("never lets more people in than the link has places for, even at the same moment", async () => {
      const alice = await signup(app, "alice");
      const inv = (await makeInvite(alice)).body.invite;
      await Invite.updateOne({ code: inv.code }, { $set: { maxUses: 2 } });
      const results = await Promise.all(["peer1", "peer2", "peer3", "peer4"].map((n, i) => request(app).post("/api/auth/register").set("x-vercel-forwarded-for", `203.0.114.${i + 1}`).send({ email: `${n}@example.com`, username: n, password: "password123", displayName: n, invite: inv.code })));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(results.filter((r) => r.body.invitedBy).length).toBe(2);
      expect(await Friendship.countDocuments()).toBe(2);
      expect((await Invite.findOne({ code: inv.code })).uses).toBe(2);
      expect((await preview(inv.code)).status).toBe(404); // now full
    });

    it("gives a new friend of a private person what any friend gets, and a stranger nothing", async () => {
      const alice = await signup(app, "alice", { private: true });
      const inv = (await makeInvite(alice)).body.invite;
      const bob = await signup(app, "bobby", { invite: inv.code });
      const cara = await signup(app, "carah");
      expect((await bob.agent.get("/api/profiles/alice")).status).toBe(200);
      expect((await cara.agent.get("/api/profiles/alice")).status).toBe(403);
    });

    it("keeps working after the link is switched off for people already in, and nobody new gets in", async () => {
      const alice = await signup(app, "alice");
      const inv = (await makeInvite(alice)).body.invite;
      await signup(app, "bobby", { invite: inv.code });
      await alice.agent.delete(`/api/invites/${inv.id}`);
      expect(await friendsOf(alice)).toEqual(["bobby"]);
      const late = await signup(app, "latecomer", { invite: inv.code });
      expect(late.res.status).toBe(201);
      expect("invitedBy" in late.res.body).toBe(false);
      expect(await friendsOf(alice)).toEqual(["bobby"]);
    });
  });

  describe("accounts going away", () => {
    it("removes an inviter's links, and an invitee's name from the list of who came in", async () => {
      const alice = await signup(app, "alice");
      const inv = (await makeInvite(alice)).body.invite;
      const bob = await signup(app, "bobby", { invite: inv.code });
      expect((await bob.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      const after = (await alice.agent.get("/api/invites")).body.invites[0];
      expect(after.joined).toEqual([]);
      expect(await Notification.countDocuments({ type: "invite_joined" })).toBe(0);
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await Invite.countDocuments()).toBe(0);
    });
  });
});
