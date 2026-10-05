import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${70 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (ms) => new Date(Date.now() + ms).toISOString();

describe("events", () => {
  let app, M, events;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    events = await import("../services/events.js");
    M = {
      User: (await import("../models/User.js")).User,
      Event: (await import("../models/Event.js")).Event,
      EventRsvp: (await import("../models/EventRsvp.js")).EventRsvp,
      Notification: (await import("../models/Notification.js")).Notification,
      Report: (await import("../models/Report.js")).Report,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const make = (who, over = {}) => who.agent.post("/api/events").send({ title: "Life drawing night", kind: "in_person", place: "The Old Mill, Leeds", startsAt: at(2 * DAY), ...over });
  const made = async (who, over = {}) => (await make(who, over)).body.event.id;
  const rsvp = (who, id, status) => who.agent.put(`/api/events/${id}/rsvp`).send({ status });
  const notes = async (who, type) => (await who.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === type);

  describe("making one", () => {
    it("makes an event with the text cleaned, and takes the host and state from the session, not the request", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const res = await make(ann, { title: "  Life​ drawing   night ", description: "Bring\r\n\r\n\r\n\r\nyour pencils", host: bob.user.id, editedAt: new Date().toISOString(), remindedAt: new Date().toISOString(), goingCount: 99 });
      expect(res.status).toBe(201);
      expect(res.body.event).toMatchObject({ title: "Life drawing night", description: "Bring\n\nyour pencils", kind: "in_person", place: "The Old Mill, Leeds", link: "", audience: "friends", editedAt: null, isHost: true, goingCount: 0, maybeCount: 0, myStatus: null });
      expect(res.body.event.host.username).toBe("ann");
      const stored = await M.Event.findById(res.body.event.id);
      expect(String(stored.host)).toBe(ann.user.id);
      expect(stored.remindedAt).toBeNull();
    });

    it("checks the title, description, kind, audience and times", async () => {
      const ann = await signup(app, "ann");
      const bad = async (over, pattern) => {
        const res = await make(ann, over);
        expect(res.status, JSON.stringify(over)).toBe(400);
        expect(res.body.error).toMatch(pattern);
      };
      await bad({ title: "   " }, /title/i);
      await bad({ title: { $gt: "" } }, /title/i);
      await bad({ title: "x".repeat(81) }, /80/);
      await bad({ description: "x".repeat(1001) }, /1000/);
      await bad({ description: 5 }, /text/);
      await bad({ kind: "hybrid" }, /in person or online/);
      await bad({ audience: "world" }, /friends or for everyone/);
      await bad({ startsAt: undefined }, /start/i);
      await bad({ startsAt: "tomorrow-ish" }, /start/i);
      await bad({ startsAt: at(-HOUR) }, /5 minutes/);
      await bad({ startsAt: at(60 * 1000) }, /5 minutes/);
      await bad({ startsAt: at(91 * DAY) }, /90 days/);
      await bad({ endsAt: at(DAY) }, /after the start/); // starts in two days
      await bad({ endsAt: at(7 * DAY) }, /3 days/);
      await bad({ endsAt: "soon" }, /end time/);
      expect((await make(ann, { endsAt: at(2 * DAY + 2 * HOUR) })).status).toBe(201);
      expect((await make(ann, { audience: "public" })).body.event.audience).toBe("public");
    });

    it("needs a place for one in person, and only takes an https link for one online", async () => {
      const ann = await signup(app, "ann");
      expect((await make(ann, { place: "" })).status).toBe(400);
      expect((await make(ann, { place: undefined })).body.error).toMatch(/where/i);
      expect((await make(ann, { place: "x".repeat(121) })).body.error).toMatch(/120/);
      const online = await make(ann, { kind: "online", place: "ignored", link: "https://meet.example.com/room?x=1" });
      expect(online.status).toBe(201);
      expect(online.body.event).toMatchObject({ kind: "online", place: "", link: "https://meet.example.com/room?x=1" });
      expect((await make(ann, { kind: "online", link: undefined })).status).toBe(201); // the link can come later
      for (const link of ["http://meet.example.com/room", "javascript:alert(1)", "https://user:pass@meet.example.com/", "data:text/html,hi", "https://localhost/", "not a link", "https://" + "a".repeat(300) + ".com", 5]) {
        const res = await make(ann, { kind: "online", link });
        expect(res.status, String(link)).toBe(400);
        expect(res.body.error).toMatch(/https/);
      }
      const inPerson = await make(ann, { kind: "in_person", place: "Cafe", link: "https://meet.example.com/x" });
      expect(inPerson.body.event.link).toBe(""); // a link isn't kept for an event in person
    });

    it("tells the host's friends, and nobody else", async () => {
      const ann = await signup(app, "ann");
      const friend = await signup(app, "friendly");
      const stranger = await signup(app, "stranger");
      await befriend(ann, friend);
      const id = await made(ann, { audience: "public" });
      const told = await notes(friend, "event_created");
      expect(told).toHaveLength(1);
      expect(told[0].actor.username).toBe("ann");
      expect(told[0].payload).toMatchObject({ eventId: id, title: "Life drawing night" });
      expect(await notes(stranger, "event_created")).toHaveLength(0);
      expect(await notes(ann, "event_created")).toHaveLength(0);
    });

    it("limits how many are planned at once and how fast", { timeout: 180_000 }, async () => {
      const ann = await signup(app, "ann");
      const ids = [];
      for (let i = 0; i < 10; i++) ids.push(await made(ann, { title: `Event ${i}` }));
      const full = await make(ann);
      expect(full.status).toBe(400);
      expect(full.body.error).toMatch(/up to 10/);
      // taking them away doesn't give back the hour's allowance
      for (const id of ids) await ann.agent.delete(`/api/events/${id}`);
      const slow = await make(ann);
      expect(slow.status).toBe(429);
      expect(slow.headers["retry-after"]).toBeTruthy();
    });

    it("needs a sign-in", async () => {
      expect((await request(app).post("/api/events").send({ title: "x" })).status).toBe(401);
      expect((await request(app).get("/api/events")).status).toBe(401);
    });
  });

  describe("who can see it", () => {
    it("shows a friends' event to the host's friends and to nobody else, in the list and by address", async () => {
      const ann = await signup(app, "ann");
      const friend = await signup(app, "friendly");
      const stranger = await signup(app, "stranger");
      await befriend(ann, friend);
      const id = await made(ann);
      expect((await friend.agent.get(`/api/events/${id}`)).status).toBe(200);
      expect((await stranger.agent.get(`/api/events/${id}`)).status).toBe(404);
      expect((await stranger.agent.get(`/api/events/${id}/guests`)).status).toBe(404);
      expect((await stranger.agent.get(`/api/events/${id}/calendar.ics`)).status).toBe(404);
      expect((await rsvp(stranger, id, "going")).status).toBe(404);
      expect((await friend.agent.get("/api/events")).body.events.map((e) => e.id)).toEqual([id]);
      expect((await stranger.agent.get("/api/events")).body.events).toEqual([]);
    });

    it("shows a public event to anyone signed in, unless the host's profile is private", async () => {
      const ann = await signup(app, "ann");
      const friend = await signup(app, "friendly");
      const stranger = await signup(app, "stranger");
      await befriend(ann, friend);
      const id = await made(ann, { audience: "public" });
      expect((await stranger.agent.get(`/api/events/${id}`)).status).toBe(200);
      await ann.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await stranger.agent.get(`/api/events/${id}`)).status).toBe(404);
      expect((await friend.agent.get(`/api/events/${id}`)).status).toBe(200);
    });

    it("hides it both ways when either has blocked the other, and when the host is suspended", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const id = await made(ann, { audience: "public" });
      await bob.agent.post(`/api/users/${ann.user.username}/block`);
      expect((await bob.agent.get(`/api/events/${id}`)).status).toBe(404);
      expect((await bob.agent.get("/api/events")).body.events).toEqual([]);
      await bob.agent.delete(`/api/users/${ann.user.username}/block`);
      await ann.agent.post(`/api/users/${bob.user.username}/block`);
      expect((await bob.agent.get(`/api/events/${id}`)).status).toBe(404);
      await ann.agent.delete(`/api/users/${bob.user.username}/block`);
      expect((await bob.agent.get(`/api/events/${id}`)).status).toBe(200);
      await M.User.updateOne({ _id: ann.user.id }, { $set: { suspendedAt: new Date() } });
      expect((await bob.agent.get(`/api/events/${id}`)).status).toBe(404);
    });

    it("answers 404 for an event that doesn't exist or an id that isn't one", async () => {
      const ann = await signup(app, "ann");
      for (const id of ["5f1d7f3b8f1d7f3b8f1d7f3b", "nope"]) {
        expect((await ann.agent.get(`/api/events/${id}`)).status, id).toBe(404);
        expect((await ann.agent.patch(`/api/events/${id}`).send({ title: "x" })).status, id).toBe(404);
        expect((await ann.agent.delete(`/api/events/${id}`)).status, id).toBe(404);
        expect((await rsvp(ann, id, "going")).status, id).toBe(404);
      }
    });
  });

  describe("the list", () => {
    it("lists what is coming soonest first, with the viewer's answer and the counts, and leaves out what is over", async () => {
      const ann = await signup(app, "ann");
      const friend = await signup(app, "friendly");
      await befriend(ann, friend);
      const later = await made(ann, { title: "Later", startsAt: at(5 * DAY) });
      const sooner = await made(ann, { title: "Sooner", startsAt: at(DAY) });
      await rsvp(friend, sooner, "going");
      // over: started long ago with no end; ended an hour ago; still running (began 2 hours ago, ends in 1)
      await M.Event.create({ host: ann.user.id, title: "Long gone", startsAt: new Date(Date.now() - 10 * HOUR), kind: "online", audience: "friends", expireAt: new Date(Date.now() + DAY) });
      await M.Event.create({ host: ann.user.id, title: "Just ended", startsAt: new Date(Date.now() - 3 * HOUR), endsAt: new Date(Date.now() - HOUR), kind: "online", audience: "friends", expireAt: new Date(Date.now() + DAY) });
      const running = await M.Event.create({ host: ann.user.id, title: "Running now", startsAt: new Date(Date.now() - 2 * HOUR), endsAt: new Date(Date.now() + HOUR), kind: "online", audience: "friends", expireAt: new Date(Date.now() + DAY) });
      const list = (await friend.agent.get("/api/events")).body;
      expect(list.events.map((e) => e.title)).toEqual(["Running now", "Sooner", "Later"]);
      expect(list.events.map((e) => e.id)).toEqual([String(running._id), sooner, later]);
      expect(list.events[1]).toMatchObject({ myStatus: "going", goingCount: 1, maybeCount: 0, isHost: false });
      expect(list.hasMore).toBe(false);
    });

    it("has a list of the ones you answered and a list of your own", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      await befriend(ann, bob);
      const a = await made(ann, { title: "A" });
      const b = await made(bob, { title: "B" });
      const c = await made(ann, { title: "C", startsAt: at(3 * DAY) });
      await rsvp(bob, a, "maybe");
      expect((await bob.agent.get("/api/events?filter=going")).body.events.map((e) => e.id)).toEqual([a]);
      expect((await bob.agent.get("/api/events?filter=mine")).body.events.map((e) => e.id)).toEqual([b]);
      expect((await ann.agent.get("/api/events?filter=mine")).body.events.map((e) => e.id)).toEqual([a, c]);
      expect((await ann.agent.get("/api/events?filter=going")).body.events).toEqual([]);
      expect((await bob.agent.get("/api/events?filter=nonsense")).body.events).toHaveLength(3); // anything else is the main list
    });

    it("pages twenty at a time", async () => {
      const ann = await signup(app, "ann");
      await M.Event.insertMany(Array.from({ length: 25 }, (_, i) => ({ host: ann.user.id, title: `E${String(i).padStart(2, "0")}`, startsAt: new Date(Date.now() + (i + 1) * HOUR), kind: "online", audience: "friends", expireAt: new Date(Date.now() + 9 * DAY) })));
      const first = (await ann.agent.get("/api/events?filter=mine")).body;
      expect(first.events).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.events[0].title).toBe("E00");
      const second = (await ann.agent.get("/api/events?filter=mine&page=2")).body;
      expect(second.events.map((e) => e.title)).toEqual(["E20", "E21", "E22", "E23", "E24"]);
      expect(second.hasMore).toBe(false);
      expect((await ann.agent.get("/api/events?filter=mine&page=abc")).body.events).toHaveLength(20);
      expect((await ann.agent.get("/api/events?filter=mine&page=-4")).body.page).toBe(1);
    });
  });

  describe("answering", () => {
    it("says going or maybe, changes its mind, and takes it back, with the counts following", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const id = await made(ann, { audience: "public" });
      expect((await rsvp(bob, id, "going")).body).toEqual({ myStatus: "going", goingCount: 1, maybeCount: 0 });
      expect((await rsvp(carol, id, "maybe")).body).toEqual({ myStatus: "maybe", goingCount: 1, maybeCount: 1 });
      expect((await rsvp(bob, id, "maybe")).body).toEqual({ myStatus: "maybe", goingCount: 0, maybeCount: 2 });
      expect((await rsvp(bob, id, "none")).body).toEqual({ myStatus: null, goingCount: 0, maybeCount: 1 });
      expect(await M.EventRsvp.countDocuments()).toBe(1);
      expect((await bob.agent.get(`/api/events/${id}`)).body.event.myStatus).toBeNull();
    });

    it("refuses nonsense, the host answering their own event, and an event that is over", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const id = await made(ann, { audience: "public" });
      expect((await rsvp(bob, id, "definitely")).status).toBe(400);
      expect((await bob.agent.put(`/api/events/${id}/rsvp`).send({})).status).toBe(400);
      expect((await rsvp(ann, id, "going")).status).toBe(400);
      await M.Event.updateOne({ _id: id }, { $set: { startsAt: new Date(Date.now() - 10 * HOUR) } });
      expect((await rsvp(bob, id, "going")).status).toBe(409);
      expect(await M.EventRsvp.countDocuments()).toBe(0);
    });

    it("lists who is going and who might, fifty a page, without people you have blocked or suspended accounts", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const dave = await signup(app, "dave");
      const id = await made(ann, { audience: "public" });
      await rsvp(bob, id, "going");
      await rsvp(carol, id, "going");
      await rsvp(dave, id, "maybe");
      const going = (await ann.agent.get(`/api/events/${id}/guests`)).body;
      expect(going.guests.map((g) => g.username)).toEqual(["bobby", "carol"]);
      expect(going.hasMore).toBe(false);
      expect((await ann.agent.get(`/api/events/${id}/guests?status=maybe`)).body.guests.map((g) => g.username)).toEqual(["dave"]);
      await ann.agent.post(`/api/users/${bob.user.username}/block`);
      expect((await ann.agent.get(`/api/events/${id}/guests`)).body.guests.map((g) => g.username)).toEqual(["carol"]);
      await M.User.updateOne({ _id: carol.user.id }, { $set: { suspendedAt: new Date() } });
      expect((await ann.agent.get(`/api/events/${id}/guests`)).body.guests).toEqual([]);
    });

    it("pages the guests", { timeout: 120_000 }, async () => {
      const ann = await signup(app, "ann");
      const id = await made(ann, { audience: "public" });
      const users = await M.User.insertMany(Array.from({ length: 55 }, (_, i) => ({ email: `g${i}@example.com`, username: `guest${i}`, passwordHash: "x", displayName: `Guest ${i}` })));
      await M.EventRsvp.insertMany(users.map((u) => ({ event: id, user: u._id, status: "going" })));
      const first = (await ann.agent.get(`/api/events/${id}/guests`)).body;
      expect(first.guests).toHaveLength(50);
      expect(first.hasMore).toBe(true);
      const second = (await ann.agent.get(`/api/events/${id}/guests?page=2`)).body;
      expect(second.guests).toHaveLength(5);
      expect(second.hasMore).toBe(false);
    });

    it("limits how fast someone can answer", { timeout: 180_000 }, async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const id = await made(ann, { audience: "public" });
      for (let i = 0; i < 120; i++) expect((await rsvp(bob, id, i % 2 ? "going" : "maybe")).status).toBe(200);
      const res = await rsvp(bob, id, "going");
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeTruthy();
    });
  });

  describe("changing one", () => {
    it("lets only the host change it, marks it edited, and checks the changes as a whole", async () => {
      const ann = await signup(app, "ann");
      const friend = await signup(app, "friendly");
      await befriend(ann, friend);
      const id = await made(ann, { description: "Bring pencils" });
      expect((await friend.agent.patch(`/api/events/${id}`).send({ title: "Mine now" })).status).toBe(404);
      expect((await request(app).patch(`/api/events/${id}`).send({ title: "x" })).status).toBe(401);
      expect((await ann.agent.patch(`/api/events/${id}`).send({ title: "  " })).status).toBe(400);
      expect((await ann.agent.patch(`/api/events/${id}`).send({ startsAt: at(60 * 1000) })).status).toBe(400);
      expect((await ann.agent.patch(`/api/events/${id}`).send({ endsAt: at(HOUR) })).body.error).toMatch(/after the start/); // before the existing start
      expect((await ann.agent.patch(`/api/events/${id}`).send({ place: "" })).body.error).toMatch(/where/i);

      const same = await ann.agent.patch(`/api/events/${id}`).send({ title: "Life drawing night" });
      expect(same.status).toBe(200);
      expect(same.body.event.editedAt).toBeNull();
      const res = await ann.agent.patch(`/api/events/${id}`).send({ title: "Life drawing night, now with tea", audience: "public", host: friend.user.id, remindedAt: new Date().toISOString() });
      expect(res.status).toBe(200);
      expect(res.body.event).toMatchObject({ title: "Life drawing night, now with tea", description: "Bring pencils", place: "The Old Mill, Leeds", audience: "public" });
      expect(res.body.event.editedAt).toBeTruthy();
      expect(String((await M.Event.findById(id)).host)).toBe(ann.user.id);
    });

    it("tells the people who answered when the time, place or link changes, and not for other changes", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const id = await made(ann, { audience: "public" });
      await rsvp(bob, id, "going");
      await rsvp(carol, id, "maybe");
      await ann.agent.patch(`/api/events/${id}`).send({ description: "More about it" });
      expect(await notes(bob, "event_updated")).toHaveLength(0);

      await ann.agent.patch(`/api/events/${id}`).send({ startsAt: at(3 * DAY) });
      const told = await notes(bob, "event_updated");
      expect(told).toHaveLength(1);
      expect(told[0].payload).toMatchObject({ eventId: id, changed: ["time"] });
      expect(await notes(carol, "event_updated")).toHaveLength(1);
      expect(await notes(ann, "event_updated")).toHaveLength(0);

      // an earlier unread note about a change is replaced, not piled up
      await ann.agent.patch(`/api/events/${id}`).send({ place: "The New Mill, Leeds" });
      const again = await notes(bob, "event_updated");
      expect(again).toHaveLength(1);
      expect(again[0].payload.changed).toEqual(["place"]);

      await ann.agent.patch(`/api/events/${id}`).send({ kind: "online", link: "https://meet.example.com/x" });
      const online = await M.Event.findById(id);
      expect(online).toMatchObject({ kind: "online", place: "", link: "https://meet.example.com/x" });
      expect((await notes(bob, "event_updated"))[0].payload.changed).toEqual(["place", "link"]);
    });

    it("can't change one that is over", async () => {
      const ann = await signup(app, "ann");
      const id = await made(ann);
      await M.Event.updateOne({ _id: id }, { $set: { startsAt: new Date(Date.now() - 10 * HOUR) } });
      expect((await ann.agent.patch(`/api/events/${id}`).send({ title: "Late edit" })).status).toBe(409);
    });
  });

  describe("cancelling one", () => {
    it("lets only the host cancel, tells the people who answered, and takes back what it sent", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const stranger = await signup(app, "stranger");
      await befriend(ann, carol);
      const id = await made(ann, { audience: "public" });
      await rsvp(bob, id, "going");
      await rsvp(carol, id, "maybe");
      expect((await stranger.agent.delete(`/api/events/${id}`)).status).toBe(404);
      expect((await bob.agent.delete(`/api/events/${id}`)).status).toBe(404);
      expect((await ann.agent.delete(`/api/events/${id}`)).status).toBe(204);
      expect(await M.Event.countDocuments()).toBe(0);
      expect(await M.EventRsvp.countDocuments()).toBe(0);
      expect(await notes(carol, "event_created")).toHaveLength(0); // the announcement is taken back
      for (const who of [bob, carol]) {
        const told = await notes(who, "event_cancelled");
        expect(told).toHaveLength(1);
        expect(told[0].payload).toMatchObject({ title: "Life drawing night" });
        expect(told[0].actor.username).toBe("ann");
      }
      expect(await notes(stranger, "event_cancelled")).toHaveLength(0);
      expect((await bob.agent.get(`/api/events/${id}`)).status).toBe(404);
    });
  });

  describe("reminders", () => {
    it("reminds the people who answered, and the host, once, an hour before", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const dave = await signup(app, "dave");
      const id = await made(ann, { audience: "public", startsAt: at(30 * 60 * 1000 + 5 * 60 * 1000) });
      await rsvp(bob, id, "going");
      await rsvp(carol, id, "maybe");
      expect(await events.processDueEventReminders(new Date())).toBe(3); // bob, carol and ann
      expect(await events.processDueEventReminders(new Date())).toBe(0); // once only
      const told = await notes(bob, "event_reminder");
      expect(told).toHaveLength(1);
      expect(told[0].payload).toMatchObject({ eventId: id, title: "Life drawing night" });
      expect((await notes(ann, "event_reminder"))[0].payload.own).toBe(true);
      expect(await notes(dave, "event_reminder")).toHaveLength(0);
    });

    it("doesn't remind yet, doesn't remind about one that began long ago, and leaves out people the host has blocked", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const id = await made(ann, { audience: "public", startsAt: at(5 * HOUR) });
      await rsvp(bob, id, "going");
      expect(await events.processDueEventReminders(new Date())).toBe(0);
      expect((await M.Event.findById(id)).remindedAt).toBeNull();

      await M.Event.updateOne({ _id: id }, { $set: { startsAt: new Date(Date.now() - 5 * HOUR) } });
      expect(await events.processDueEventReminders(new Date())).toBe(0); // too late to be useful, and claimed so it doesn't try again
      expect((await M.Event.findById(id)).remindedAt).not.toBeNull();

      const second = await made(ann, { audience: "public", startsAt: at(HOUR) });
      await rsvp(bob, second, "going");
      await rsvp(carol, second, "going");
      await ann.agent.post(`/api/users/${carol.user.username}/block`);
      expect(await events.processDueEventReminders(new Date())).toBe(2); // bob and ann, not carol
      expect(await notes(carol, "event_reminder")).toHaveLength(0);
    });

    it("sends a new reminder when the time moves", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const id = await made(ann, { audience: "public", startsAt: at(40 * 60 * 1000) });
      await rsvp(bob, id, "going");
      expect(await events.processDueEventReminders(new Date())).toBe(2);
      await ann.agent.patch(`/api/events/${id}`).send({ startsAt: at(DAY) });
      expect((await M.Event.findById(id)).remindedAt).toBeNull();
      await M.Event.updateOne({ _id: id }, { $set: { startsAt: new Date(Date.now() + 30 * 60 * 1000) } });
      expect(await events.processDueEventReminders(new Date())).toBe(2);
    });

    it("is also caught up when someone looks at their notifications", async () => {
      const ann = await signup(app, "ann");
      const id = await made(ann, { startsAt: at(20 * 60 * 1000 + 6 * 60 * 1000) });
      await M.Event.updateOne({ _id: id }, { $set: { startsAt: new Date(Date.now() + 20 * 60 * 1000) } });
      await new Promise((r) => setTimeout(r, 15_200)); // the casual check is spaced out
      expect(await notes(ann, "event_reminder")).toHaveLength(1);
    });
  });

  describe("adding to a calendar", () => {
    it("gives an .ics file with the details escaped and long lines folded", async () => {
      const ann = await signup(app, "ann");
      const id = await made(ann, { title: "Show, tell; and \\ more", description: "Line one\nLine two " + "é".repeat(100), endsAt: at(2 * DAY + 3 * HOUR) });
      const res = await ann.agent.get(`/api/events/${id}/calendar.ics`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/calendar/);
      expect(res.headers["content-disposition"]).toMatch(/attachment/);
      const text = res.text;
      expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
      expect(text).toContain("SUMMARY:Show\\, tell\\; and \\\\ more");
      expect(text).toContain("LOCATION:The Old Mill\\, Leeds");
      expect(text).toContain(`UID:${id}@creativesselect.com`);
      expect(text).toMatch(/DTSTART:\d{8}T\d{6}Z/);
      expect(text).toMatch(/DTEND:\d{8}T\d{6}Z/);
      for (const line of text.split("\r\n")) expect(Buffer.byteLength(line), line.slice(0, 30)).toBeLessThanOrEqual(75);
      const unfolded = text.replace(/\r\n /g, "");
      expect(unfolded).toContain("DESCRIPTION:Line one\\nLine two " + "é".repeat(100));
    });

    it("ends an hour after the start when there is no end, and uses the link for an online event", async () => {
      const ann = await signup(app, "ann");
      const id = await made(ann, { kind: "online", link: "https://meet.example.com/room" });
      const text = (await ann.agent.get(`/api/events/${id}/calendar.ics`)).text;
      const stamp = (name) => text.match(new RegExp(`${name}:(\\d{8}T\\d{6})Z`))[1];
      const parse = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
      expect(parse(stamp("DTEND")) - parse(stamp("DTSTART"))).toBe(HOUR);
      expect(text).toContain("LOCATION:https://meet.example.com/room");
    });
  });

  describe("when accounts go away", () => {
    it("removes a host's events with the answers to them, and a guest's answers, with the reports", async () => {
      const ann = await signup(app, "ann");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const annsEvent = await made(ann, { audience: "public" });
      const carolsEvent = await made(carol, { audience: "public" });
      await rsvp(bob, annsEvent, "going");
      await rsvp(ann, carolsEvent, "going");
      await rsvp(bob, carolsEvent, "maybe");
      await bob.agent.post("/api/reports").send({ targetType: "event", targetId: annsEvent, reason: "spam" });
      expect(await M.Report.countDocuments({ targetType: "event" })).toBe(1);

      expect((await ann.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect((await M.Event.find()).map((e) => String(e._id))).toEqual([carolsEvent]);
      const answers = await M.EventRsvp.find();
      expect(answers.map((r) => String(r.user))).toEqual([bob.user.id]);
      expect(await M.Report.countDocuments({ targetType: "event" })).toBe(0);
    });
  });
});
