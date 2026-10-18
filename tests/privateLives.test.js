import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("invite-only live rooms", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      LiveSession: (await import("../models/Live.js")).LiveSession,
      LiveListener: (await import("../models/Live.js")).LiveListener,
      Notification: (await import("../models/Notification.js")).Notification,
      ScheduledLive: (await import("../models/ScheduledLive.js")).ScheduledLive,
      User: (await import("../models/User.js")).User,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const goPrivate = (who, invite, title = "Just us") => who.agent.post("/api/live").send({ title, private: true, ...(invite ? { invite: invite.map((p) => p.user.id) } : {}) });
  const listed = async (who) => (await who.agent.get("/api/live")).body.lives;
  const join = (who, id) => who.agent.post(`/api/live/${id}/join`);
  const notices = (who, type) => M.Notification.find({ recipient: who.user.id, type });

  /** host with three friends: ann and ben (who get invited) and cat (who doesn't), plus dee, who is nobody's friend. */
  async function circle() {
    const host = await signup(app, "host");
    const [ann, ben, cat, dee] = await Promise.all(["ann", "ben", "cat", "dee"].map((n) => signup(app, n)));
    for (const f of [ann, ben, cat]) await befriend(host, f);
    return { host, ann, ben, cat, dee };
  }

  describe("starting one", () => {
    it("is shown, to its host and the people invited, as private, and to nobody else", async () => {
      const { host, ann, ben, cat, dee } = await circle();
      const started = await goPrivate(host, [ann, ben]);
      expect(started.status).toBe(201);
      expect(started.body.live).toMatchObject({ private: true, isHost: true, title: "Just us" });
      for (const who of [host, ann, ben]) {
        const lives = await listed(who);
        expect(lives).toHaveLength(1);
        expect(lives[0].private).toBe(true);
      }
      // the host's other friend, and a stranger, are not told it exists
      expect(await listed(cat)).toEqual([]);
      expect(await listed(dee)).toEqual([]);
      const id = started.body.live.id;
      for (const who of [cat, dee]) {
        expect((await who.agent.get(`/api/live/${id}`)).status).toBe(404);
        expect((await join(who, id)).status).toBe(404);
        expect((await who.agent.post(`/api/live/${id}/heartbeat`)).status).toBe(404);
        expect((await who.agent.get(`/api/live/${id}/comments`)).status).toBe(403);
      }
      expect((await ann.agent.get(`/api/live/${id}`)).body.live.private).toBe(true);
    });

    it("lets the people invited join, and keeps the others out of the room itself", async () => {
      const { host, ann, cat } = await circle();
      const id = (await goPrivate(host, [ann])).body.live.id;
      expect((await join(ann, id)).status).toBe(200);
      expect((await join(cat, id)).status).toBe(404);
      expect(await M.LiveListener.countDocuments({ session: id })).toBe(1);
      expect((await ann.agent.post(`/api/live/${id}/comments`).send({ body: "hi" })).status).toBe(201);
    });

    it("tells only the people invited, and never the host's other friends", async () => {
      const { host, ann, ben, cat } = await circle();
      await goPrivate(host, [ann, ben]);
      expect(await notices(ann, "live_invite")).toHaveLength(1);
      expect((await notices(ann, "live_invite"))[0].payload).toMatchObject({ title: "Just us", actorId: host.user.id });
      expect(await notices(ben, "live_invite")).toHaveLength(1);
      expect(await notices(cat, "live_invite")).toHaveLength(0);
      expect(await M.Notification.countDocuments({ type: "live_started" })).toBe(0);
    });

    it("takes the invitations away when the live ends", async () => {
      const { host, ann } = await circle();
      const id = (await goPrivate(host, [ann])).body.live.id;
      expect(await notices(ann, "live_invite")).toHaveLength(1);
      await host.agent.post(`/api/live/${id}/end`);
      expect(await notices(ann, "live_invite")).toHaveLength(0);
    });

    it("can start with nobody invited yet, and a public live is unchanged: shown to everyone, friends told", async () => {
      const { host, cat, dee } = await circle();
      expect((await goPrivate(host)).status).toBe(201);
      expect(await listed(cat)).toEqual([]);
      await host.agent.post(`/api/live/${(await listed(host))[0].id}/end`);
      const open = await host.agent.post("/api/live").send({ title: "Open mic" });
      expect(open.body.live.private).toBe(false);
      expect((await listed(dee)).map((l) => l.private)).toEqual([false]);
      expect(await notices(cat, "live_started")).toHaveLength(1);
    });
  });

  describe("who can be invited", () => {
    it("is friends only: a stranger, a friend who is blocked, or yourself is refused and no live is made", async () => {
      const { host, ann, dee } = await circle();
      const stranger = await goPrivate(host, [dee]);
      expect(stranger.status).toBe(400);
      expect(stranger.body.error).toBe("You can only invite your friends");
      expect((await goPrivate(host, [host])).status).toBe(400);
      await host.agent.post(`/api/users/${ann.user.username}/block`);
      expect((await goPrivate(host, [ann])).status).toBe(400);
      expect(await M.LiveSession.countDocuments()).toBe(0);
    });

    it("refuses a badly formed request", async () => {
      const { host, ann } = await circle();
      expect((await host.agent.post("/api/live").send({ title: "x", private: "yes" })).body.error).toBe("private must be true or false");
      const publicWithList = await host.agent.post("/api/live").send({ title: "x", invite: [ann.user.id] });
      expect(publicWithList.body.error).toBe("Only an invite-only live has invitations");
      expect((await host.agent.post("/api/live").send({ title: "x", private: true, invite: "ann" })).body.error).toBe("Invitations must be a list of people");
      expect((await host.agent.post("/api/live").send({ title: "x", private: true, invite: ["nope"] })).body.error).toBe("That isn't a person you can invite");
      // the same person twice counts once
      const twice = await host.agent.post("/api/live").send({ title: "x", private: true, invite: [ann.user.id, ann.user.id] });
      expect(twice.status).toBe(201);
      expect((await M.LiveSession.findById(twice.body.live.id)).invited).toHaveLength(1);
    });
  });

  describe("inviting more people while it is on, and taking an invitation back", () => {
    it("lets the host add people, who are told and can then see and join it", async () => {
      const { host, ann, cat } = await circle();
      const id = (await goPrivate(host, [ann])).body.live.id;
      const added = await host.agent.post(`/api/live/${id}/invites`).send({ userIds: [cat.user.id, ann.user.id] });
      expect(added.status).toBe(201);
      expect(added.body.invited.map((i) => i.user.username).sort()).toEqual(["ann", "cat"]);
      expect(added.body.max).toBe(100);
      expect(await notices(cat, "live_invite")).toHaveLength(1);
      // ann was already invited and isn't told again
      expect(await notices(ann, "live_invite")).toHaveLength(1);
      expect((await listed(cat)).map((l) => l.id)).toEqual([id]);
      expect((await join(cat, id)).status).toBe(200);
    });

    it("shows the host who is invited and who is in the room", async () => {
      const { host, ann, ben } = await circle();
      const id = (await goPrivate(host, [ann, ben])).body.live.id;
      await join(ann, id);
      const list = (await host.agent.get(`/api/live/${id}/invites`)).body;
      expect(Object.fromEntries(list.invited.map((i) => [i.user.username, i.present]))).toEqual({ ann: true, ben: false });
      expect(JSON.stringify(list)).not.toContain("@example.com");
    });

    it("refuses people who aren't friends, a full list, and a live that isn't invite-only or is over", async () => {
      const { host, ann, dee } = await circle();
      const id = (await goPrivate(host, [ann])).body.live.id;
      expect((await host.agent.post(`/api/live/${id}/invites`).send({ userIds: [dee.user.id] })).body.error).toBe("You can only invite your friends");
      expect((await host.agent.post(`/api/live/${id}/invites`).send({ userIds: "ann" })).status).toBe(400);
      // a full list
      await M.LiveSession.updateOne({ _id: id }, { $set: { invited: Array.from({ length: 100 }, () => new mongoose.Types.ObjectId()) } });
      const ben = await signup(app, "ben2");
      await befriend(host, ben);
      const full = await host.agent.post(`/api/live/${id}/invites`).send({ userIds: [ben.user.id] });
      expect(full.status).toBe(400);
      expect(full.body.error).toBe("You can invite up to 100 people");
      // a public live has no invitations
      await host.agent.post(`/api/live/${id}/end`);
      const open = (await host.agent.post("/api/live").send({ title: "Open" })).body.live.id;
      const refused = await host.agent.post(`/api/live/${open}/invites`).send({ userIds: [ann.user.id] });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("This live isn't invite-only");
      // over
      const again = (await goPrivate(host, [ann])).body.live.id;
      await M.LiveSession.updateOne({ _id: again }, { $set: { status: "ended" } });
      expect((await host.agent.post(`/api/live/${again}/invites`).send({ userIds: [ann.user.id] })).status).toBe(409);
    });

    it("is only for the host", async () => {
      const { host, ann, cat } = await circle();
      const id = (await goPrivate(host, [ann])).body.live.id;
      for (const who of [ann, cat]) {
        expect((await who.agent.get(`/api/live/${id}/invites`)).status).toBe(404);
        expect((await who.agent.post(`/api/live/${id}/invites`).send({ userIds: [cat.user.id] })).status).toBe(404);
        expect((await who.agent.delete(`/api/live/${id}/invites/${ann.user.id}`)).status).toBe(404);
      }
      expect((await M.LiveSession.findById(id)).invited).toHaveLength(1);
    });

    it("takes an invitation back: they lose sight of it, are removed if they are in it, and their notice goes", async () => {
      const { host, ann, ben } = await circle();
      const id = (await goPrivate(host, [ann, ben])).body.live.id;
      await join(ann, id);
      expect((await host.agent.delete(`/api/live/${id}/invites/${ann.user.id}`)).status).toBe(204);
      expect(await listed(ann)).toEqual([]);
      expect((await ann.agent.get(`/api/live/${id}`)).status).toBe(404);
      expect((await ann.agent.post(`/api/live/${id}/heartbeat`)).status).toBe(404);
      expect(await M.LiveListener.countDocuments({ session: id, user: ann.user.id })).toBe(0);
      expect(await notices(ann, "live_invite")).toHaveLength(0);
      expect(await notices(ben, "live_invite")).toHaveLength(1);
      expect((await host.agent.delete(`/api/live/${id}/invites/${ann.user.id}`)).status).toBe(404);
      expect((await host.agent.delete(`/api/live/${id}/invites/nope`)).status).toBe(404);
    });
  });

  describe("everything else still holds", () => {
    it("hides it from someone who blocks the host, even if they were invited", async () => {
      const { host, ann } = await circle();
      const id = (await goPrivate(host, [ann])).body.live.id;
      await ann.agent.post(`/api/users/${host.user.username}/block`);
      expect(await listed(ann)).toEqual([]);
      expect((await ann.agent.get(`/api/live/${id}`)).status).toBe(404);
    });

    it("starting a planned live as invite-only closes the plan without telling the people who asked for a reminder", async () => {
      const { host, ann, cat } = await circle();
      const plan = await M.ScheduledLive.create({ host: host.user.id, title: "Planned", startsAt: new Date(Date.now() + 3600_000), reminders: [cat.user.id], expireAt: new Date(Date.now() + 86_400_000) });
      const started = await host.agent.post("/api/live").send({ title: "Planned", private: true, invite: [ann.user.id], scheduledId: String(plan._id) });
      expect(started.status).toBe(201);
      expect((await M.ScheduledLive.findById(plan._id)).status).toBe("started");
      expect(await notices(cat, "live_started")).toHaveLength(0);
      expect(await notices(cat, "live_invite")).toHaveLength(0);
      expect(await notices(ann, "live_invite")).toHaveLength(1);
    });

    it("takes a deleted account off other people's invitation lists", async () => {
      const { host, ann, ben } = await circle();
      const id = (await goPrivate(host, [ann, ben])).body.live.id;
      const res = await ann.agent.delete("/api/profiles/me").send({ password: "password123" });
      expect(res.status).toBe(204);
      expect((await M.LiveSession.findById(id)).invited.map(String)).toEqual([ben.user.id]);
    });

    it("pushes an invitation under the live switch, with words in each language", async () => {
      const { categoryOf } = await import("../utils/pushInput.js");
      const { PUSH_TEXT } = await import("../utils/pushText.js").catch(() => ({}));
      expect(categoryOf("live_invite")).toBe("live");
      if (PUSH_TEXT) expect(Object.keys(PUSH_TEXT.live_invite)).toEqual(["en", "es", "ar"]);
    });
  });
});
