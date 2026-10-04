import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.101.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  if (extra.private) await agent.patch("/api/profiles/me").send({ isPrivate: true });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();

describe("scheduled lives", () => {
  let app, ScheduledLive, Notification, services;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ ScheduledLive } = await import("../models/ScheduledLive.js"));
    ({ Notification } = await import("../models/Notification.js"));
    services = await import("../services/scheduledLives.js");
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const plan = (who, over = {}) => who.agent.post("/api/scheduled-lives").send({ title: "Friday jam", startsAt: inMinutes(120), ...over });
  const upcoming = async (who) => (await who.agent.get("/api/scheduled-lives")).body.scheduled;
  const notes = async (who, type) => (await who.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === type);

  describe("making a plan", () => {
    it("needs a sign-in", async () => {
      expect((await request(app).get("/api/scheduled-lives")).status).toBe(401);
      expect((await request(app).post("/api/scheduled-lives").send({})).status).toBe(401);
    });

    it("creates one with a title and a time, and lists it", async () => {
      const alice = await signup(app, "alice");
      const res = await plan(alice, { title: "  Songwriting hour  " });
      expect(res.status).toBe(201);
      expect(res.body.scheduled).toMatchObject({ title: "Songwriting hour", isHost: true, reminding: false, reminderCount: 0 });
      expect(res.body.scheduled.host.username).toBe("alice");
      const list = await upcoming(alice);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(res.body.scheduled.id);
    });

    it("tells the host's accepted friends, and nobody else", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      await befriend(alice, bob);
      await plan(alice);
      const told = await notes(bob, "live_scheduled");
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ payload: { title: "Friday jam", scheduledId: expect.any(String), startsAt: expect.any(String) }, actor: { username: "alice" } });
      expect(await notes(cara, "live_scheduled")).toHaveLength(0);
      expect(await notes(alice, "live_scheduled")).toHaveLength(0);
    });

    it("checks the title", async () => {
      const alice = await signup(app, "alice");
      for (const title of ["", "   ", undefined, 5, "x".repeat(81)]) expect((await plan(alice, { title })).status, String(title)).toBe(400);
      expect((await plan(alice, { title: "x".repeat(80) })).status).toBe(201);
    });

    it("checks the time: a real one, at least 5 minutes away and no more than 30 days", async () => {
      const alice = await signup(app, "alice");
      for (const startsAt of [undefined, "", "tomorrow", 12345, "2020-01-01T00:00:00Z", inMinutes(1), inMinutes(4), inMinutes(60 * 24 * 31)]) {
        expect((await plan(alice, { startsAt })).status, String(startsAt)).toBe(400);
      }
      expect((await plan(alice, { startsAt: inMinutes(6) })).status).toBe(201);
      expect((await plan(alice, { startsAt: inMinutes(60 * 24 * 29) })).status).toBe(201);
    });

    it("allows 5 at a time, and a cancelled one frees a place", async () => {
      const alice = await signup(app, "alice");
      const made = [];
      for (let i = 0; i < 5; i++) made.push((await plan(alice, { title: `Live ${i}` })).body.scheduled.id);
      const sixth = await plan(alice, { title: "Sixth" });
      expect(sixth.status).toBe(400);
      expect(sixth.body.error).toMatch(/up to 5/);
      expect((await alice.agent.delete(`/api/scheduled-lives/${made[0]}`)).status).toBe(204);
      expect((await plan(alice, { title: "Sixth" })).status).toBe(201);
    });
  });

  describe("who sees what", () => {
    it("shows everyone's public plans, soonest first", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await plan(bob, { title: "Later", startsAt: inMinutes(300) });
      await plan(alice, { title: "Sooner", startsAt: inMinutes(60) });
      expect((await upcoming(alice)).map((p) => p.title)).toEqual(["Sooner", "Later"]);
      expect((await upcoming(bob)).map((p) => [p.title, p.isHost])).toEqual([["Sooner", false], ["Later", true]]);
    });

    it("hides a private host's plans from everyone but their friends (and themselves)", async () => {
      const alice = await signup(app, "alice", { private: true });
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      await befriend(alice, bob);
      await plan(alice);
      expect(await upcoming(alice)).toHaveLength(1);
      expect(await upcoming(bob)).toHaveLength(1);
      expect(await upcoming(cara)).toHaveLength(0);
    });

    it("hides plans from people blocked either way, as if they didn't exist", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      const { body } = await plan(alice);
      await alice.agent.post("/api/users/bobby/block");
      await cara.agent.post("/api/users/alice/block");
      for (const who of [bob, cara]) {
        expect(await upcoming(who)).toHaveLength(0);
        const res = await who.agent.post(`/api/scheduled-lives/${body.scheduled.id}/remind`);
        expect(res.status).toBe(404);
      }
    });

    it("keeps a plan listed for a little while after its time, then drops it", async () => {
      const alice = await signup(app, "alice");
      const { body } = await plan(alice);
      await ScheduledLive.updateOne({ _id: body.scheduled.id }, { $set: { startsAt: new Date(Date.now() - 10 * 60_000) } });
      expect(await upcoming(alice)).toHaveLength(1);
      await ScheduledLive.updateOne({ _id: body.scheduled.id }, { $set: { startsAt: new Date(Date.now() - 45 * 60_000) } });
      expect(await upcoming(alice)).toHaveLength(0);
    });
  });

  describe("asking to be reminded", () => {
    it("can be turned on and off, with a count", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      const id = (await plan(alice)).body.scheduled.id;
      expect((await bob.agent.post(`/api/scheduled-lives/${id}/remind`)).body).toEqual({ reminding: true, reminderCount: 1 });
      expect((await cara.agent.post(`/api/scheduled-lives/${id}/remind`)).body).toEqual({ reminding: true, reminderCount: 2 });
      expect((await bob.agent.post(`/api/scheduled-lives/${id}/remind`)).body.reminderCount).toBe(2); // asking twice is harmless
      expect((await upcoming(bob))[0]).toMatchObject({ reminding: true, reminderCount: 2 });
      expect((await upcoming(alice))[0]).toMatchObject({ reminding: false, reminderCount: 2 });
      expect((await bob.agent.delete(`/api/scheduled-lives/${id}/remind`)).body).toEqual({ reminding: false, reminderCount: 1 });
      expect((await upcoming(bob))[0].reminding).toBe(false);
    });

    it("isn't needed by the host, and fails for a plan that isn't there", async () => {
      const alice = await signup(app, "alice");
      const id = (await plan(alice)).body.scheduled.id;
      expect((await alice.agent.post(`/api/scheduled-lives/${id}/remind`)).status).toBe(400);
      const nowhere = new mongoose.Types.ObjectId().toString();
      expect((await alice.agent.post(`/api/scheduled-lives/${nowhere}/remind`)).status).toBe(404);
      expect((await alice.agent.post("/api/scheduled-lives/nope/remind")).status).toBe(404);
    });

    it("can't be asked of a live that has already begun", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = (await plan(alice)).body.scheduled.id;
      await ScheduledLive.updateOne({ _id: id }, { $set: { startsAt: new Date(Date.now() - 40 * 60_000) } });
      expect((await bob.agent.post(`/api/scheduled-lives/${id}/remind`)).status).toBe(409);
    });
  });

  describe("cancelling", () => {
    it("is only for the host, removes it from the list, and takes its announcements and reminders away", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      const id = (await plan(alice)).body.scheduled.id;
      await bob.agent.post(`/api/scheduled-lives/${id}/remind`);
      expect((await bob.agent.delete(`/api/scheduled-lives/${id}`)).status).toBe(404);
      expect(await upcoming(bob)).toHaveLength(1);
      expect(await notes(bob, "live_scheduled")).toHaveLength(1);

      expect((await alice.agent.delete(`/api/scheduled-lives/${id}`)).status).toBe(204);
      expect(await upcoming(bob)).toHaveLength(0);
      expect(await notes(bob, "live_scheduled")).toHaveLength(0);
      expect((await alice.agent.delete(`/api/scheduled-lives/${id}`)).status).toBe(404); // already gone
      expect((await bob.agent.post(`/api/scheduled-lives/${id}/remind`)).status).toBe(404);
    });
  });

  describe("the reminder", () => {
    it("goes to everyone who asked, and the host, ten minutes before — once", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      const dee = await signup(app, "deedee");
      const id = (await plan(alice, { startsAt: inMinutes(60) })).body.scheduled.id;
      await bob.agent.post(`/api/scheduled-lives/${id}/remind`);
      await cara.agent.post(`/api/scheduled-lives/${id}/remind`);

      expect(await services.processDueReminders(new Date())).toBe(0); // an hour out: too early
      expect(await notes(bob, "live_reminder")).toHaveLength(0);

      const nearly = new Date(Date.now() + 52 * 60_000); // eight minutes before the start
      expect(await services.processDueReminders(nearly)).toBe(3);
      for (const who of [bob, cara]) {
        const [n] = await notes(who, "live_reminder");
        expect(n).toMatchObject({ payload: { title: "Friday jam", scheduledId: id }, actor: { username: "alice" } });
        expect(n.payload.own).toBeUndefined();
      }
      expect((await notes(alice, "live_reminder"))[0].payload.own).toBe(true);
      expect(await notes(dee, "live_reminder")).toHaveLength(0); // didn't ask

      expect(await services.processDueReminders(nearly)).toBe(0); // never twice
      expect(await notes(bob, "live_reminder")).toHaveLength(1);
    });

    it("is sent when someone looks at their notifications or the schedule, so a sleeping server catches up", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = (await plan(alice, { startsAt: inMinutes(60) })).body.scheduled.id;
      await bob.agent.post(`/api/scheduled-lives/${id}/remind`);
      await ScheduledLive.updateOne({ _id: id }, { $set: { startsAt: new Date(Date.now() + 5 * 60_000) } });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 20_000); // past the spacing between casual checks
      try {
        expect(await notes(bob, "live_reminder")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("isn't sent to someone the host has blocked since, and isn't sent for a plan that is long past", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = (await plan(alice, { startsAt: inMinutes(60) })).body.scheduled.id;
      await bob.agent.post(`/api/scheduled-lives/${id}/remind`);
      await alice.agent.post("/api/users/bobby/block");
      await services.processDueReminders(new Date(Date.now() + 55 * 60_000));
      expect(await notes(bob, "live_reminder")).toHaveLength(0);

      const late = (await plan(alice, { title: "Missed", startsAt: inMinutes(30) })).body.scheduled.id;
      const carlos = await signup(app, "carlos");
      await carlos.agent.post(`/api/scheduled-lives/${late}/remind`);
      expect(await services.processDueReminders(new Date(Date.now() + 5 * 60 * 60_000))).toBe(0); // five hours on: not worth sending
      expect(await notes(carlos, "live_reminder")).toHaveLength(0);
      expect((await ScheduledLive.findById(late)).remindedAt).not.toBeNull(); // and not retried either
    });

    it("isn't sent for a cancelled plan", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = (await plan(alice, { startsAt: inMinutes(60) })).body.scheduled.id;
      await bob.agent.post(`/api/scheduled-lives/${id}/remind`);
      await alice.agent.delete(`/api/scheduled-lives/${id}`);
      expect(await services.processDueReminders(new Date(Date.now() + 55 * 60_000))).toBe(0);
    });
  });

  describe("going live as planned", () => {
    it("closes the plan, and tells people who asked for a reminder but aren't friends that it is on", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby"); // a friend: already told by the usual live notice
      const cara = await signup(app, "carah"); // not a friend, asked for a reminder
      await befriend(alice, bob);
      const id = (await plan(alice)).body.scheduled.id;
      await bob.agent.post(`/api/scheduled-lives/${id}/remind`);
      await cara.agent.post(`/api/scheduled-lives/${id}/remind`);

      const live = await alice.agent.post("/api/live").send({ title: "Friday jam", scheduledId: id });
      expect(live.status).toBe(201);
      expect((await ScheduledLive.findById(id)).status).toBe("started");
      expect(String((await ScheduledLive.findById(id)).liveId)).toBe(live.body.live.id);
      expect(await upcoming(cara)).toHaveLength(0);
      expect(await notes(bob, "live_scheduled")).toHaveLength(0); // the announcement is gone
      expect(await notes(bob, "live_started")).toHaveLength(1); // told once, not twice
      const [n] = await notes(cara, "live_started");
      expect(n.payload).toMatchObject({ liveId: live.body.live.id, title: "Friday jam" });
    });

    it("ignores a plan id that is wrong, someone else's, or already used — the live still starts", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = (await plan(bob)).body.scheduled.id;
      for (const scheduledId of ["nope", new mongoose.Types.ObjectId().toString(), id, 12, {}]) {
        const live = await alice.agent.post("/api/live").send({ title: "Anyway", scheduledId });
        expect(live.status, JSON.stringify(scheduledId)).toBe(201);
      }
      expect((await ScheduledLive.findById(id)).status).toBe("scheduled"); // bob's plan is untouched
    });
  });

  describe("housekeeping", () => {
    it("removes a person's plans and their reminders when they delete their account", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = (await plan(alice)).body.scheduled.id;
      const other = (await plan(bob, { title: "Bob's" })).body.scheduled.id;
      await alice.agent.post(`/api/scheduled-lives/${other}/remind`);
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await ScheduledLive.findById(id)).toBeNull();
      expect((await ScheduledLive.findById(other)).reminders).toHaveLength(0);
      expect(await Notification.countDocuments({ "payload.scheduledId": id })).toBe(0);
    });

    it("sets a plan to be deleted a couple of days after its time", async () => {
      const alice = await signup(app, "alice");
      const start = inMinutes(120);
      const id = (await plan(alice, { startsAt: start })).body.scheduled.id;
      const { expireAt } = await ScheduledLive.findById(id);
      expect(expireAt.getTime() - new Date(start).getTime()).toBe(services.KEEP_AFTER_MS);
    });
  });
});
