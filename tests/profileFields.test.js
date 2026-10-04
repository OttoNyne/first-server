import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { checkLine, checkTags, cleanLine, isValidTag, normalizeTag } from "../utils/profileFields.js";

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

describe("cleaning small profile fields", () => {
  it("drops control and invisible characters and tidies spaces, but keeps everything printable as typed", () => {
    expect(cleanLine("  feeling\tcreative\n today  ")).toBe("feeling creative today");
    expect(cleanLine("a​b\u0000c")).toBe("a b c");
    expect(cleanLine("<b>hi</b> & \"you\" 🎨 café")).toBe("<b>hi</b> & \"you\" 🎨 café");
  });

  it("checks length and type", () => {
    expect(checkLine("  ok  ", 10, "Mood")).toEqual({ value: "ok" });
    expect(checkLine("", 10, "Mood")).toEqual({ value: "" });
    expect(checkLine("x".repeat(11), 10, "Mood").error).toMatch(/up to 10 characters/);
    for (const bad of [5, null, {}, ["a"], true]) expect(checkLine(bad, 10, "Mood").error).toMatch(/must be text/);
  });

  it("turns a tag into its stored form", () => {
    expect(normalizeTag("  #Illustrator ")).toBe("illustrator");
    expect(normalizeTag("Street   Art")).toBe("street art");
    expect(normalizeTag("lo - fi")).toBe("lo-fi");
    expect(normalizeTag("##Music Producer")).toBe("music producer");
    expect(normalizeTag(5)).toBe("");
  });

  it("accepts letters and numbers in any language, spaces and hyphens, 2 to 24 long", () => {
    for (const ok of ["ab", "illustrator", "3d artist", "lo-fi", "музыкант", "写真", "x".repeat(24)]) expect(isValidTag(ok), ok).toBe(true);
    for (const bad of ["a", "", "x".repeat(25), "-dash", " space", "a_b", "tag!", "<b>", "a.b", "😀😀"]) expect(isValidTag(bad), bad).toBe(false);
  });

  it("cleans a list: lower case, no repeats, at most 8", () => {
    expect(checkTags(["Painter", "#painter", " Potter "]).value).toEqual(["painter", "potter"]);
    expect(checkTags([]).value).toEqual([]);
    expect(checkTags(Array.from({ length: 8 }, (_, i) => `tag ${i}`)).value).toHaveLength(8);
    expect(checkTags(Array.from({ length: 9 }, (_, i) => `tag ${i}`)).error).toMatch(/up to 8 tags/);
    expect(checkTags(["ok", "!!"]).error).toMatch(/isn't a valid tag/);
    expect(checkTags("painter").error).toMatch(/must be a list/);
    expect(checkTags([5]).error).toMatch(/must be text/);
  });
});

describe("mood, what someone is listening to, and tags", () => {
  let app;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const save = (who, body) => who.agent.patch("/api/profiles/me").send(body);

  describe("saving them", () => {
    it("start empty, can be set, shown on the profile to anyone, and changed or cleared", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      expect(alice.user).toMatchObject({ mood: "", listeningTo: "", tags: [] });
      const res = await save(alice, { mood: "  ✨ feeling creative ", listeningTo: "Clair de Lune – Debussy", tags: ["Painter", "#Street Art"] });
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ mood: "✨ feeling creative", listeningTo: "Clair de Lune – Debussy", tags: ["painter", "street art"] });
      expect((await bob.agent.get("/api/profiles/alice")).body.user).toMatchObject({ mood: "✨ feeling creative", listeningTo: "Clair de Lune – Debussy", tags: ["painter", "street art"] });
      await save(alice, { mood: "", tags: [] });
      expect((await bob.agent.get("/api/profiles/alice")).body.user).toMatchObject({ mood: "", listeningTo: "Clair de Lune – Debussy", tags: [] });
    });

    it("leave the others alone when only one is sent", async () => {
      const alice = await signup(app, "alice");
      await save(alice, { mood: "calm", listeningTo: "rain", tags: ["potter"] });
      const res = await save(alice, { mood: "busy" });
      expect(res.body.user).toMatchObject({ mood: "busy", listeningTo: "rain", tags: ["potter"] });
    });

    it("are refused when too long or not the right kind of thing, and nothing changes", async () => {
      const alice = await signup(app, "alice");
      await save(alice, { mood: "calm", tags: ["potter"] });
      const bad = [
        { mood: "x".repeat(61) },
        { listeningTo: "x".repeat(81) },
        { mood: 5 },
        { mood: { $ne: "" } },
        { listeningTo: ["a"] },
        { tags: "potter" },
        { tags: [5] },
        { tags: ["!!"] },
        { tags: [{ $ne: "" }] },
        { tags: Array.from({ length: 9 }, (_, i) => `tag ${i}`) },
        { mood: "fine", tags: ["x"] }, // one bad field refuses the lot
      ];
      for (const body of bad) expect((await save(alice, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect((await alice.agent.get("/api/profiles/alice")).body.user).toMatchObject({ mood: "calm", tags: ["potter"] });
    });

    it("keep markup as plain text, never interpreted", async () => {
      const alice = await signup(app, "alice");
      const res = await save(alice, { mood: "<script>alert(1)</script>", listeningTo: "AC/DC & <b>friends</b>" });
      expect(res.body.user).toMatchObject({ mood: "<script>alert(1)</script>", listeningTo: "AC/DC & <b>friends</b>" }); // returned as text for the page to draw as text
    });

    it("lose hidden characters and line breaks", async () => {
      const alice = await signup(app, "alice");
      const res = await save(alice, { mood: "line one\nline two​!", listeningTo: "a\tb" });
      expect(res.body.user).toMatchObject({ mood: "line one line two !", listeningTo: "a b" });
    });

    it("are hidden along with the rest of a private profile", async () => {
      const alice = await signup(app, "alice", { private: true });
      const stranger = await signup(app, "stranger");
      await save(alice, { mood: "secret", tags: ["hidden"] });
      const seen = (await stranger.agent.get("/api/profiles/alice")).body.user;
      expect(seen?.mood).toBeUndefined();
      expect(seen?.tags).toBeUndefined();
      expect(JSON.stringify(seen ?? {})).not.toContain("secret");
    });

    it("can't be the name of something else: a person can't take 'discover' or 'tags' as a username", async () => {
      for (const username of ["discover", "TAGS"]) {
        const res = await request(app).post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.102.${++signups}`).send({ email: `${username}@example.com`, username, password: "password123", displayName: "x" });
        expect(res.status, username).toBe(400);
        expect(res.body.error).toMatch(/isn't available/);
      }
    });
  });

  describe("discovering people", () => {
    it("lists public creatives, newest first, never yourself, never anyone private", async () => {
      const alice = await signup(app, "alice");
      await signup(app, "oldone");
      await signup(app, "newest");
      await signup(app, "hidden1", { private: true });
      const res = await alice.agent.get("/api/profiles/discover");
      expect(res.status).toBe(200);
      expect(res.body.users.map((u) => u.username)).toEqual(["newest", "oldone"]);
      expect(res.body).toMatchObject({ page: 1, hasMore: false });
    });

    it("can be narrowed to a tag", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      await save(bob, { tags: ["potter", "ceramics"] });
      await save(cara, { tags: ["painter"] });
      expect((await alice.agent.get("/api/profiles/discover?tag=potter")).body.users.map((u) => u.username)).toEqual(["bobby"]);
      expect((await alice.agent.get("/api/profiles/discover?tag=%23Painter")).body.users.map((u) => u.username)).toEqual(["carah"]); // # and capitals are fine
      expect((await alice.agent.get("/api/profiles/discover?tag=nobody-uses-this")).body.users).toEqual([]);
    });

    it("refuses a tag that couldn't be one", async () => {
      const alice = await signup(app, "alice");
      for (const tag of ["!!", "a", "x".repeat(40), "<b>"]) expect((await alice.agent.get(`/api/profiles/discover?tag=${encodeURIComponent(tag)}`)).status, tag).toBe(400);
      // an object in place of a tag (an injection attempt) is either refused or ignored; it is never used as a query
      const injected = await alice.agent.get("/api/profiles/discover?tag[$ne]=x");
      expect([200, 400]).toContain(injected.status);
    });

    it("leaves out people who have blocked you or whom you have blocked", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      await signup(app, "dee");
      await alice.agent.post("/api/users/bobby/block");
      await cara.agent.post("/api/users/alice/block");
      expect((await alice.agent.get("/api/profiles/discover")).body.users.map((u) => u.username)).toEqual(["dee"]);
      expect((await bob.agent.get("/api/profiles/discover")).body.users.map((u) => u.username)).toEqual(["dee", "carah", "alice"].filter((n) => n !== "alice"));
    });

    it("comes in pages of 20", async () => {
      const alice = await signup(app, "alice");
      const User = (await import("../models/User.js")).User;
      await User.insertMany(Array.from({ length: 25 }, (_, i) => ({ email: `p${i}@example.com`, username: `person${String(i).padStart(2, "0")}`, passwordHash: "x", displayName: `P${i}` })));
      const first = (await alice.agent.get("/api/profiles/discover")).body;
      expect(first.users).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      const second = (await alice.agent.get("/api/profiles/discover?page=2")).body;
      expect(second.users).toHaveLength(5);
      expect(second.hasMore).toBe(false);
      expect(new Set([...first.users, ...second.users].map((u) => u.username)).size).toBe(25);
      expect((await alice.agent.get("/api/profiles/discover?page=banana")).body.page).toBe(1);
      expect((await alice.agent.get("/api/profiles/discover?page=0")).body.page).toBe(1);
      expect((await alice.agent.get("/api/profiles/discover?page=9999")).body.page).toBe(50);
    });

    it("needs a sign-in", async () => {
      expect((await request(app).get("/api/profiles/discover")).status).toBe(401);
      expect((await request(app).get("/api/profiles/tags")).status).toBe(401);
    });

    it("still finds a profile by its username, whatever the discover route is called", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      expect((await bob.agent.get("/api/profiles/alice")).body.user.username).toBe("alice");
      expect((await alice.agent.get("/api/profiles/tagsy")).status).toBe(404);
    });
  });

  describe("popular tags", () => {
    it("counts the tags people use, most used first, public profiles only", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      const dee = await signup(app, "dee", { private: true });
      await save(alice, { tags: ["painter", "potter"] });
      await save(bob, { tags: ["painter", "musician"] });
      await save(cara, { tags: ["painter", "musician", "dancer"] });
      await save(dee, { tags: ["painter", "secretive"] });
      const { tags } = (await alice.agent.get("/api/profiles/tags")).body;
      expect(tags).toEqual([{ tag: "painter", count: 3 }, { tag: "musician", count: 2 }, { tag: "dancer", count: 1 }, { tag: "potter", count: 1 }]);
      expect(tags.find((t) => t.tag === "secretive")).toBeUndefined();
    });

    it("can be narrowed to those starting with what is typed, for suggestions", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await save(alice, { tags: ["illustrator", "illustration", "ink"] });
      await save(bob, { tags: ["illustrator"] });
      expect((await alice.agent.get("/api/profiles/tags?q=ill")).body.tags).toEqual([{ tag: "illustrator", count: 2 }, { tag: "illustration", count: 1 }]);
      expect((await alice.agent.get("/api/profiles/tags?q=%23ILL")).body.tags).toHaveLength(2);
      expect((await alice.agent.get("/api/profiles/tags?q=.*")).body.tags).toEqual([]); // typed characters are not a pattern
      expect((await alice.agent.get("/api/profiles/tags?q=zzz")).body.tags).toEqual([]);
    });

    it("is empty when nobody has tags, and shows at most 24", async () => {
      const alice = await signup(app, "alice");
      expect((await alice.agent.get("/api/profiles/tags")).body.tags).toEqual([]);
      await save(alice, { tags: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"] });
      const User = (await import("../models/User.js")).User;
      await User.insertMany(Array.from({ length: 5 }, (_, i) => ({ email: `q${i}@example.com`, username: `tagger${i}`, passwordHash: "x", displayName: "x", tags: Array.from({ length: 8 }, (_, j) => `group${i} item${j}`) })));
      expect((await alice.agent.get("/api/profiles/tags")).body.tags).toHaveLength(24);
    });
  });
});
