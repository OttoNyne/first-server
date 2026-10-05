import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${30 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("About me", () => {
  let app, M, birthdays;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    birthdays = await import("../services/birthdays.js");
    M = {
      User: (await import("../models/User.js")).User,
      Notification: (await import("../models/Notification.js")).Notification,
      Report: (await import("../models/Report.js")).Report,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const save = (who, body) => who.agent.put("/api/about/me").send(body);
  const read = (who, username) => who.agent.get(`/api/about/${username}`);
  const notes = async (who, type) => (await who.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === type);

  describe("saving", () => {
    it("starts empty and keeps what the owner writes, cleaned, with line breaks kept", async () => {
      const alice = await signup(app, "alice");
      expect((await read(alice, "alice")).body).toEqual({ about: { interests: "", music: "", movies: "", books: "", meet: "" }, location: "", birthday: null, locationAudience: "friends" });
      const res = await save(alice, { interests: "  Painting​ and\r\n\r\n\r\n\r\nclay  ", music: "Jazz, mostly", movies: "Stalker", books: "The Dispossessed", meet: "People who make things" });
      expect(res.status).toBe(200);
      expect(res.body.about).toEqual({ interests: "Painting and\n\nclay", music: "Jazz, mostly", movies: "Stalker", books: "The Dispossessed", meet: "People who make things" });
      expect((await read(alice, "alice")).body.about.interests).toBe("Painting and\n\nclay");
    });

    it("changes only what is sent, and clears a field with an empty string", async () => {
      const alice = await signup(app, "alice");
      await save(alice, { interests: "Painting", music: "Jazz" });
      const res = await save(alice, { music: "" });
      expect(res.body.about).toMatchObject({ interests: "Painting", music: "" });
    });

    it("checks the text, the place and the audience", async () => {
      const alice = await signup(app, "alice");
      const bad = async (body, pattern) => {
        const res = await save(alice, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error).toMatch(pattern);
      };
      await bad({ interests: "x".repeat(301) }, /300/);
      await bad({ music: 5 }, /text/);
      await bad({ books: { $gt: "" } }, /text/);
      await bad({ location: "x".repeat(61) }, /60/);
      await bad({ location: 5 }, /text/);
      await bad({ locationAudience: "world" }, /friends or everyone/);
      await bad({}, /Nothing to change/);
      await bad({ unknown: "x" }, /Nothing to change/);
      await bad([], /fields/);
      expect((await save(alice, { interests: "x".repeat(300) })).status).toBe(200);
    });

    it("keeps the place to one line", async () => {
      const alice = await signup(app, "alice");
      expect((await save(alice, { location: "  Leeds,\n  ​ England " })).body.location).toBe("Leeds, England");
    });

    it("needs a sign-in, and only ever changes the signed-in person's own", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      expect((await request(app).put("/api/about/me").send({ interests: "x" })).status).toBe(401);
      await save(bob, { interests: "Bob's things", username: "alice", user: alice.user.id });
      expect((await read(alice, "alice")).body.about.interests).toBe("");
    });

    it("limits how many changes someone can make an hour", { timeout: 180_000 }, async () => {
      const alice = await signup(app, "alice");
      for (let i = 0; i < 60; i++) expect((await save(alice, { interests: `v${i}` })).status).toBe(200);
      const res = await save(alice, { interests: "one more" });
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeTruthy();
    });
  });

  describe("who sees what", () => {
    it("shows the answers to anyone who can see the profile, signed in or not, and a stranger gets nothing of a private one", async () => {
      const alice = await signup(app, "alice");
      const stranger = await signup(app, "stranger");
      await save(alice, { interests: "Painting" });
      expect((await request(app).get("/api/about/alice")).body.about.interests).toBe("Painting");
      expect((await read(stranger, "alice")).body.about.interests).toBe("Painting");
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await read(stranger, "alice")).status).toBe(403);
      expect((await request(app).get("/api/about/alice")).status).toBe(403);
    });

    it("answers 404 for someone who doesn't exist, and for a suspended account", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      expect((await read(bob, "nobody")).status).toBe(404);
      await M.User.updateOne({ _id: alice.user.id }, { $set: { suspendedAt: new Date() } });
      expect((await read(bob, "alice")).status).toBe(404);
    });

    it("hides it from someone who is blocked either way", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await save(alice, { interests: "Painting" });
      await bob.agent.post(`/api/users/${alice.user.username}/block`);
      expect((await read(bob, "alice")).status).toBe(403);
      await bob.agent.delete(`/api/users/${alice.user.username}/block`);
      await alice.agent.post(`/api/users/${bob.user.username}/block`);
      expect((await read(bob, "alice")).status).toBe(403);
    });

    it("shows the place to friends only by default, to everyone when the owner says so, and always to the owner with the setting", async () => {
      const alice = await signup(app, "alice");
      const friend = await signup(app, "friendly");
      const stranger = await signup(app, "stranger");
      await befriend(alice, friend);
      await save(alice, { location: "Leeds" });
      expect((await read(alice, "alice")).body).toMatchObject({ location: "Leeds", locationAudience: "friends" });
      expect((await read(friend, "alice")).body.location).toBe("Leeds");
      expect((await read(stranger, "alice")).body.location).toBe("");
      expect((await request(app).get("/api/about/alice")).body.location).toBe("");
      expect((await read(stranger, "alice")).body).not.toHaveProperty("locationAudience");

      await save(alice, { locationAudience: "everyone" });
      expect((await read(stranger, "alice")).body.location).toBe("Leeds");
      expect((await request(app).get("/api/about/alice")).body.location).toBe("Leeds");
      await save(alice, { location: "" });
      expect((await read(friend, "alice")).body.location).toBe("");
    });
  });

  describe("the birthday", () => {
    it("is shared with friends and the owner only, as a month and day with no year", async () => {
      const alice = await signup(app, "alice");
      const friend = await signup(app, "friendly");
      const stranger = await signup(app, "stranger");
      await befriend(alice, friend);
      const res = await save(alice, { birthday: { month: 3, day: 4, year: 1990 } });
      expect(res.body.birthday).toEqual({ month: 3, day: 4 });
      expect((await read(friend, "alice")).body.birthday).toEqual({ month: 3, day: 4 });
      expect((await read(stranger, "alice")).body.birthday).toBeNull();
      expect((await request(app).get("/api/about/alice")).body.birthday).toBeNull();
      expect(JSON.stringify((await M.User.findById(alice.user.id)).birthday)).not.toContain("1990");
      await alice.agent.delete(`/api/friends/${friend.user.id}`);
      expect((await read(friend, "alice")).body.birthday).toBeNull();
    });

    it("must be a real day, and can be stopped, which forgets it", async () => {
      const alice = await signup(app, "alice");
      for (const birthday of [{ month: 13, day: 1 }, { month: 0, day: 5 }, { month: 2, day: 30 }, { month: 4, day: 31 }, { month: 1, day: 0 }, { month: "3", day: 4 }, { month: 3.5, day: 4 }, { month: 3 }, "march 4", [3, 4], 7]) {
        const res = await save(alice, { birthday });
        expect(res.status, JSON.stringify(birthday)).toBe(400);
        expect(res.body.error).toMatch(/real month and day/);
      }
      expect((await save(alice, { birthday: { month: 2, day: 29 } })).status).toBe(200);
      expect((await save(alice, { birthday: null })).body.birthday).toBeNull();
      expect((await M.User.findById(alice.user.id)).birthday?.month).toBeUndefined();
    });

    it("tells the friends on the day, once a year, and not anyone else", async () => {
      const alice = await signup(app, "alice");
      const friend = await signup(app, "friendly");
      const stranger = await signup(app, "stranger");
      await befriend(alice, friend);
      await save(alice, { birthday: { month: 3, day: 4 } });
      expect(await birthdays.processBirthdays(new Date("2027-03-03T12:00:00Z"))).toBe(0); // the day before
      expect(await birthdays.processBirthdays(new Date("2027-03-04T09:00:00Z"))).toBe(1);
      expect(await birthdays.processBirthdays(new Date("2027-03-04T15:00:00Z"))).toBe(0); // once
      const told = await notes(friend, "friend_birthday");
      expect(told).toHaveLength(1);
      expect(told[0].actor.username).toBe("alice");
      expect(await notes(stranger, "friend_birthday")).toHaveLength(0);
      expect(await notes(alice, "friend_birthday")).toHaveLength(0);
      // setting it again the same year doesn't send another; the next year does
      await save(alice, { birthday: null });
      await save(alice, { birthday: { month: 3, day: 4 } });
      expect(await birthdays.processBirthdays(new Date("2027-03-04T20:00:00Z"))).toBe(0);
      expect(await birthdays.processBirthdays(new Date("2028-03-04T09:00:00Z"))).toBe(1);
    });

    it("leaves out friends who are blocked either way, and accounts that are suspended", async () => {
      const alice = await signup(app, "alice");
      const kept = await signup(app, "kept");
      const blocked = await signup(app, "blocked");
      await befriend(alice, kept);
      await befriend(alice, blocked);
      await save(alice, { birthday: { month: 6, day: 1 } });
      await alice.agent.post(`/api/users/${blocked.user.username}/block`);
      expect(await birthdays.processBirthdays(new Date("2027-06-01T09:00:00Z"))).toBe(1);
      expect(await notes(blocked, "friend_birthday")).toHaveLength(0);

      const suspended = await signup(app, "suspended");
      await befriend(suspended, kept);
      await save(suspended, { birthday: { month: 6, day: 1 } });
      await M.User.updateOne({ _id: suspended.user.id }, { $set: { suspendedAt: new Date() } });
      expect(await birthdays.processBirthdays(new Date("2028-06-01T09:00:00Z"))).toBe(1); // alice's again, not the suspended one's
    });

    it("keeps a 29 February birthday for 28 February in a year with no 29th", async () => {
      const alice = await signup(app, "alice");
      const friend = await signup(app, "friendly");
      await befriend(alice, friend);
      await save(alice, { birthday: { month: 2, day: 29 } });
      expect(await birthdays.processBirthdays(new Date("2027-02-27T09:00:00Z"))).toBe(0);
      expect(await birthdays.processBirthdays(new Date("2027-02-28T09:00:00Z"))).toBe(1); // 2027 has no 29th
      expect(await birthdays.processBirthdays(new Date("2028-02-28T09:00:00Z"))).toBe(0); // 2028 does: wait for the 29th
      expect(await birthdays.processBirthdays(new Date("2028-02-29T09:00:00Z"))).toBe(1);
    });
  });

  describe("sections, reports and deletion", () => {
    it("is a section of the profile, first by default, that can be moved and hidden like the others", async () => {
      const alice = await signup(app, "alice");
      expect(alice.user.sectionOrder[0]).toBe("about");
      const order = ["friends", "music", "portfolio", "blog", "testimonials", "about"];
      const res = await alice.agent.patch("/api/profiles/me").send({ sectionOrder: order, hiddenSections: ["about"] });
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ sectionOrder: order, hiddenSections: ["about"] });
    });

    it("adds an existing person's saved order with the new section at the end", async () => {
      const alice = await signup(app, "alice");
      await M.User.updateOne({ _id: alice.user.id }, { $set: { sectionOrder: ["music", "friends", "portfolio", "blog", "testimonials"] } });
      const me = await alice.agent.get("/api/auth/me");
      expect(me.body.user.sectionOrder).toEqual(["music", "friends", "portfolio", "blog", "testimonials", "about"]);
    });

    it("shows the answers to a moderator who reviews a report about the account", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await save(alice, { interests: "Something rude", location: "Somewhere" });
      expect((await bob.agent.post("/api/reports").send({ targetType: "user", targetId: alice.user.id, reason: "rude" })).status).toBe(201);
      const { loadTarget } = await import("../services/moderation.js");
      const target = await loadTarget("user", alice.user.id, bob.user.id);
      expect(target.preview.text).toContain("Something rude");
      expect(target.preview.text).toContain("Somewhere");
    });

    it("goes with the account, taking the birthday notes it sent", async () => {
      const alice = await signup(app, "alice");
      const friend = await signup(app, "friendly");
      await befriend(alice, friend);
      await save(alice, { interests: "x", birthday: { month: 5, day: 5 } });
      await birthdays.processBirthdays(new Date("2027-05-05T09:00:00Z"));
      expect(await M.Notification.countDocuments({ type: "friend_birthday" })).toBe(1);
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await M.Notification.countDocuments({ type: "friend_birthday" })).toBe(0);
      expect((await read(friend, "alice")).status).toBe(404);
    });
  });
});
