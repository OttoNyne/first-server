import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.102.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  if (extra.private) await agent.patch("/api/profiles/me").send({ isPrivate: true });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("blog entries", () => {
  let app, BlogEntry, Notification, Report;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ BlogEntry } = await import("../models/BlogEntry.js"));
    ({ Notification } = await import("../models/Notification.js"));
    ({ Report } = await import("../models/Report.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const write = (who, over = {}) => who.agent.post("/api/blog").send({ title: "A day in the studio", body: "First paragraph.\n\nSecond paragraph.", ...over });
  const listOf = (viewer, username, page) => viewer.agent.get(`/api/blog/user/${username}${page ? `?page=${page}` : ""}`);
  const notes = async (who) => (await who.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "blog_post");

  describe("writing", () => {
    it("needs a sign-in to write or to read a single entry, but a public profile's list can be read without one", async () => {
      const alice = await signup(app, "alice");
      expect((await request(app).get("/api/blog/user/alice")).status).toBe(200); // a public profile, read like the rest of it
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await request(app).get("/api/blog/user/alice")).status).toBe(403); // a private one is not
      expect((await request(app).get("/api/blog/5f1d7f3b8f1d7f3b8f1d7f3b")).status).toBe(401);
      expect((await request(app).post("/api/blog").send({})).status).toBe(401);
    });

    it("saves an entry with its title and paragraphs, shown to its author as theirs", async () => {
      const alice = await signup(app, "alice");
      const res = await write(alice, { title: "  Hello   world ", body: "  One.\r\n\r\n\r\n\r\nTwo.   \n" });
      expect(res.status).toBe(201);
      expect(res.body.entry).toMatchObject({ title: "Hello world", body: "One.\n\nTwo.", isAuthor: true });
      expect(res.body.entry.author.username).toBe("alice");
      const got = await alice.agent.get(`/api/blog/${res.body.entry.id}`);
      expect(got.body.entry.body).toBe("One.\n\nTwo.");
    });

    it("keeps text as typed, including < and &, and drops hidden characters", async () => {
      const alice = await signup(app, "alice");
      const sneaky = `Hi​ there‮ <b>bold</b> & more\u0007`;
      const res = await write(alice, { title: "T​itle", body: sneaky });
      expect(res.body.entry.title).toBe("T itle"); // in a title a hidden character becomes a space
      expect(res.body.entry.body).toBe("Hi there <b>bold</b> & more");
    });

    it("checks the title and the text", async () => {
      const alice = await signup(app, "alice");
      for (const title of ["", "   ", undefined, 7, "x".repeat(121)]) expect((await write(alice, { title })).status, String(title)).toBe(400);
      for (const body of ["", "  \n ", undefined, 7, ["a"], "x".repeat(10001)]) expect((await write(alice, { body })).status, String(body).slice(0, 10)).toBe(400);
      expect(await BlogEntry.countDocuments()).toBe(0);
      expect((await write(alice, { body: "x".repeat(10000) })).status).toBe(201);
    });

    it("limits how many an hour, and how many are kept", async () => {
      const alice = await signup(app, "alice");
      for (let i = 0; i < 10; i++) expect((await write(alice, { title: `Entry ${i}` })).status).toBe(201);
      const res = await write(alice);
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeTruthy();

      const bob = await signup(app, "bobby");
      await BlogEntry.insertMany(Array.from({ length: 200 }, (_, i) => ({ author: bob.user.id, title: `Old ${i}`, body: "x" })));
      expect((await write(bob)).status).toBe(400);
    });
  });

  describe("reading", () => {
    it("lists someone's entries newest first, ten a page, with an excerpt instead of the whole text", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const long = "word ".repeat(100);
      for (let i = 1; i <= 12; i++) await BlogEntry.create({ author: alice.user.id, title: `Entry ${i}`, body: i === 12 ? long : `Body ${i}`, createdAt: new Date(Date.now() - (13 - i) * 1000) });
      const first = (await listOf(bob, "alice")).body;
      expect(first.entries).toHaveLength(10);
      expect(first.hasMore).toBe(true);
      expect(first.entries[0].title).toBe("Entry 12");
      expect(first.entries[0].excerpt.length).toBeLessThanOrEqual(201);
      expect(first.entries[0].excerpt.endsWith("…")).toBe(true);
      expect(first.entries[0]).not.toHaveProperty("body");
      const second = (await listOf(bob, "alice", 2)).body;
      expect(second.entries.map((e) => e.title)).toEqual(["Entry 2", "Entry 1"]);
      expect(second.hasMore).toBe(false);
    });

    it("answers a page that is far too high, or not a number, sensibly", async () => {
      const alice = await signup(app, "alice");
      await write(alice);
      expect((await listOf(alice, "alice", 9999)).body.entries).toEqual([]);
      expect((await alice.agent.get("/api/blog/user/alice?page=abc")).body.entries).toHaveLength(1);
    });

    it("404s for a person who doesn't exist, and for entries that aren't there or ids that aren't ids", async () => {
      const alice = await signup(app, "alice");
      expect((await listOf(alice, "nobody")).status).toBe(404);
      expect((await alice.agent.get("/api/blog/5f1d7f3b8f1d7f3b8f1d7f3b")).status).toBe(404);
      expect((await alice.agent.get("/api/blog/not-an-id")).status).toBe(404);
    });

    it("hides a private profile's entries from strangers, as 404 for a single entry, but not from friends", async () => {
      const alice = await signup(app, "alice", { private: true });
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      const entry = (await write(alice)).body.entry;
      await befriend(alice, bob);

      expect((await listOf(cara, "alice")).status).toBe(403);
      expect((await cara.agent.get(`/api/blog/${entry.id}`)).status).toBe(404);
      expect((await listOf(bob, "alice")).body.entries).toHaveLength(1);
      const seen = await bob.agent.get(`/api/blog/${entry.id}`);
      expect(seen.status).toBe(200);
      expect(seen.body.entry.isAuthor).toBe(false);
    });

    it("hides entries between people who have blocked each other, in both directions", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const entry = (await write(alice)).body.entry;
      await bob.agent.post("/api/users/alice/block");
      expect((await listOf(bob, "alice")).status).toBe(403);
      expect((await bob.agent.get(`/api/blog/${entry.id}`)).status).toBe(404);
      expect((await alice.agent.get(`/api/blog/${entry.id}`)).status).toBe(200);
      const bobEntry = (await write(bob)).body.entry;
      expect((await alice.agent.get(`/api/blog/${bobEntry.id}`)).status).toBe(404);
    });
  });

  describe("telling friends", () => {
    it("tells the author's accepted friends once, and nobody else", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      await befriend(alice, bob);
      const entry = (await write(alice)).body.entry;
      const told = await notes(bob);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ payload: { entryId: entry.id, title: "A day in the studio" }, actor: { username: "alice" } });
      expect(await notes(cara)).toHaveLength(0);
      expect(await notes(alice)).toHaveLength(0);
      // an edit is not a new announcement
      await alice.agent.put(`/api/blog/${entry.id}`).send({ body: "Changed" });
      expect(await notes(bob)).toHaveLength(1);
    });

    it("takes the announcement back when the entry is deleted", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      const entry = (await write(alice)).body.entry;
      expect((await alice.agent.delete(`/api/blog/${entry.id}`)).status).toBe(204);
      expect(await notes(bob)).toHaveLength(0);
    });
  });

  describe("changing and deleting", () => {
    it("lets the author change the title, the text or both, and checks the new values", async () => {
      const alice = await signup(app, "alice");
      const entry = (await write(alice)).body.entry;
      const url = `/api/blog/${entry.id}`;
      expect((await alice.agent.put(url).send({ title: "New title" })).body.entry).toMatchObject({ title: "New title", body: "First paragraph.\n\nSecond paragraph." });
      expect((await alice.agent.put(url).send({ body: "New text" })).body.entry).toMatchObject({ title: "New title", body: "New text" });
      expect((await alice.agent.put(url).send({ title: "", body: "ok" })).status).toBe(400);
      expect((await alice.agent.put(url).send({})).status).toBe(400);
      expect((await alice.agent.put(url).send({ body: "x".repeat(10001) })).status).toBe(400);
      expect((await BlogEntry.findById(entry.id)).title).toBe("New title");
    });

    it("never lets anyone else change or delete it, and answers as if it didn't exist", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const entry = (await write(alice)).body.entry;
      expect((await bob.agent.put(`/api/blog/${entry.id}`).send({ title: "Hijacked" })).status).toBe(404);
      expect((await bob.agent.delete(`/api/blog/${entry.id}`)).status).toBe(404);
      expect((await BlogEntry.findById(entry.id)).title).toBe("A day in the studio");
      expect((await alice.agent.put("/api/blog/not-an-id").send({ title: "x" })).status).toBe(404);
      expect((await alice.agent.delete("/api/blog/not-an-id")).status).toBe(404);
    });

    it("deletes an entry for good", async () => {
      const alice = await signup(app, "alice");
      const entry = (await write(alice)).body.entry;
      expect((await alice.agent.delete(`/api/blog/${entry.id}`)).status).toBe(204);
      expect((await alice.agent.get(`/api/blog/${entry.id}`)).status).toBe(404);
      expect((await alice.agent.delete(`/api/blog/${entry.id}`)).status).toBe(404);
    });

    it("can't be written to through extra fields, such as another author", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const res = await write(alice, { author: bob.user.id, createdAt: "2001-01-01" });
      const saved = await BlogEntry.findById(res.body.entry.id);
      expect(String(saved.author)).toBe(alice.user.id);
      expect(saved.createdAt.getFullYear()).toBeGreaterThan(2020);
    });
  });

  describe("reports and account deletion", () => {
    it("can be reported", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const entry = (await write(alice)).body.entry;
      const res = await bob.agent.post("/api/reports").send({ targetType: "blogEntry", targetId: entry.id, reason: "spam" });
      expect(res.status).toBe(201);
      expect(await Report.countDocuments({ targetType: "blogEntry" })).toBe(1);
    });

    it("goes with the account, with its announcements and reports", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      const entry = (await write(alice)).body.entry;
      await bob.agent.post("/api/reports").send({ targetType: "blogEntry", targetId: entry.id, reason: "spam" });
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await BlogEntry.countDocuments()).toBe(0);
      expect(await Report.countDocuments({ targetType: "blogEntry" })).toBe(0);
      expect(await Notification.countDocuments({ type: "blog_post" })).toBe(0);
    });
  });
});
