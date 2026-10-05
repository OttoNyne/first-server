import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { MAX_SEARCH_WORDS, hasAllWords, hasAnyWord, parseQuery, snippetOf, wordsFilter } from "../utils/searchInput.js";

let signups = 0;
async function signup(app, name, displayName = name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${230 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName });
  return { agent, user: res.body.user, name };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("search words", () => {
  it("turns what was typed into lower-case words, once each", () => {
    expect(parseQuery("  Jazz   POSTER jazz ")).toEqual({ words: ["jazz", "poster"] });
  });

  it("refuses what can't be searched for", () => {
    for (const bad of [undefined, null, 5, {}, ["a"], "", "   ", "a", "x".repeat(41), "x".repeat(301)]) expect(parseQuery(bad).error).toBeTruthy();
    expect(parseQuery("a b c").error).toBe("Type at least two letters");
    expect(parseQuery(Array.from({ length: MAX_SEARCH_WORDS + 1 }, (_, i) => `word${i}`).join(" ")).error).toMatch(/up to 5 words/);
    expect(parseQuery("a jazz").words).toEqual(["a", "jazz"]);
  });

  it("matches every word as plain text, never as a pattern", () => {
    const filter = wordsFilter(["a.b", "(x+)+"], ["title"]);
    expect(filter.$and).toHaveLength(2);
    expect(filter.$and[0].$or[0].title.$regex).toBe("a\\.b");
    expect(filter.$and[1].$or[0].title.$regex).toBe("\\(x\\+\\)\\+");
  });

  it("finds words and shows the part of the text around the first one", () => {
    expect(hasAllWords("Hand Thrown Mugs", ["hand", "mugs"])).toBe(true);
    expect(hasAllWords("Hand Thrown Mugs", ["hand", "bowls"])).toBe(false);
    expect(hasAnyWord("Hand Thrown Mugs", ["bowls", "mugs"])).toBe(true);
    const long = `${"word ".repeat(60)}kiln${" other".repeat(60)}`;
    const snippet = snippetOf(long, ["kiln"]);
    expect(snippet).toContain("kiln");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThan(200);
    expect(snippetOf("short text", ["text"])).toBe("short text");
    expect(snippetOf("", ["x"])).toBe("");
    expect(snippetOf("line one\n\n  line two", ["two"])).toBe("line one line two");
  });
});

describe("search", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const find = (who, params) => who.agent.get(`/api/search?${new URLSearchParams(params)}`);
  const people = async (who, q, extra = {}) => (await find(who, { q, ...extra })).body.results.map((u) => u.username);

  describe("asking", () => {
    it("is for signed-in people only", async () => {
      expect((await request(app).get("/api/search?q=jazz")).status).toBe(401);
    });

    it("checks the question", async () => {
      const me = await signup(app, "mimi");
      expect((await find(me, {})).status).toBe(400);
      expect((await find(me, { q: "a" })).status).toBe(400);
      expect((await find(me, { q: "jazz", type: "everything" })).status).toBe(400);
      expect((await find(me, { q: "jazz", tag: "!!" })).status).toBe(400);
      expect((await find(me, { q: "jazz", tag: "potter", type: "blog" })).status).toBe(400);
      expect((await find(me, { q: "jazz", connection: "stranger" })).status).toBe(400);
      expect((await find(me, { q: "jazz", connection: "friends", type: "groups" })).status).toBe(400);
    });

    it("searches people by default, and says which words it looked for", async () => {
      const me = await signup(app, "mimi");
      await signup(app, "zorro", "Zorro Z");
      const res = await find(me, { q: " ZORRO " });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe("people");
      expect(res.body.words).toEqual(["zorro"]);
      expect(res.body.results.map((u) => u.username)).toEqual(["zorro"]);
    });

    it("slows someone who searches too fast", async () => {
      const me = await signup(app, "mimi");
      await M.RateLimitHit.insertMany(Array.from({ length: 60 }, () => ({ key: `search:${me.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
      const res = await find(me, { q: "zorro" });
      expect(res.status).toBe(429);
    });
  });

  describe("people", () => {
    it("puts an exact username first, then names that start with it, then the rest", async () => {
      const me = await signup(app, "mimi");
      await signup(app, "mugwump", "Marcus Pottery");
      await signup(app, "potter", "Someone Else");
      await signup(app, "potterfan", "Fan");
      await signup(app, "bigpotterman", "Big Man");
      expect(await people(me, "potter")).toEqual(["potter", "potterfan", "mugwump", "bigpotterman"]);
    });

    it("needs every word, in any order, in the name, username, tags or bio", async () => {
      const me = await signup(app, "mimi");
      const kiln = await signup(app, "kilnkate", "Kate Ceramics");
      await kiln.agent.patch("/api/profiles/me").send({ tags: ["potter"], bio: "I fire stoneware in a wood kiln" });
      await signup(app, "kilnkim", "Kim Glass");
      expect(await people(me, "kiln")).toEqual(expect.arrayContaining(["kilnkate", "kilnkim"]));
      expect(await people(me, "ceramics kate")).toEqual(["kilnkate"]);
      expect(await people(me, "potter stoneware")).toEqual(["kilnkate"]);
      expect(await people(me, "stoneware glass")).toEqual([]);
    });

    it("never lists yourself, someone suspended, or anyone blocked either way", async () => {
      const me = await signup(app, "mimi", "Quill Mimi");
      const a = await signup(app, "quillone", "Quill One");
      const b = await signup(app, "quilltwo", "Quill Two");
      const c = await signup(app, "quillthree", "Quill Three");
      await signup(app, "quillfour", "Quill Four");
      expect(await people(me, "quill")).toEqual(expect.arrayContaining(["quillone", "quilltwo", "quillthree", "quillfour"]));
      expect(await people(me, "quill")).not.toContain("mimi");

      await me.agent.post("/api/users/quillone/block"); // I blocked them
      await b.agent.post("/api/users/mimi/block"); // they blocked me
      await M.User.updateOne({ _id: c.user.id }, { suspendedAt: new Date() });
      expect((await people(me, "quill")).sort()).toEqual(["quillfour"]);
      expect(await people(a, "quill")).not.toContain("mimi");
    });

    it("finds a private profile by its name, but never by what the profile says", async () => {
      const me = await signup(app, "mimi");
      const hidden = await signup(app, "shy", "Shy Person");
      await hidden.agent.patch("/api/profiles/me").send({ tags: ["origami"], bio: "I fold origami cranes", isPrivate: true });
      expect(await people(me, "shy")).toEqual(["shy"]);
      expect(await people(me, "origami")).toEqual([]);
      expect(await people(me, "cranes")).toEqual([]);
      expect(await people(me, "shy", { tag: "origami" })).toEqual([]);
      // the result is the same restricted card as anywhere else
      const card = (await find(me, { q: "shy" })).body.results[0];
      expect(card.bio).toBeUndefined();
      expect(card.tags).toBeUndefined();
      // a friend can find them by it
      await befriend(me, hidden);
      expect(await people(me, "origami")).toEqual(["shy"]);
      expect(await people(me, "cranes")).toEqual(["shy"]);
      expect(await people(me, "shy", { tag: "origami" })).toEqual(["shy"]);
    });

    it("filters by tag", async () => {
      const me = await signup(app, "mimi");
      const a = await signup(app, "sculptoranna", "Anna");
      const b = await signup(app, "sculptorben", "Ben");
      await a.agent.patch("/api/profiles/me").send({ tags: ["sculptor", "clay"] });
      await b.agent.patch("/api/profiles/me").send({ tags: ["sculptor"] });
      expect((await people(me, "sculptor")).sort()).toEqual(["sculptoranna", "sculptorben"]);
      expect(await people(me, "sculptor", { tag: "clay" })).toEqual(["sculptoranna"]);
      expect(await people(me, "sculptor", { tag: "#Clay" })).toEqual(["sculptoranna"]);
      expect(await people(me, "sculptor", { tag: "painting" })).toEqual([]);
    });

    it("favours people you share friends with, and says how many", async () => {
      const me = await signup(app, "mimi");
      const f1 = await signup(app, "fone");
      const f2 = await signup(app, "ftwo");
      const far = await signup(app, "weaverfar", "Weaver Far");
      const near = await signup(app, "weavernear", "Weaver Near");
      const mid = await signup(app, "weavermid", "Weaver Mid");
      await befriend(me, f1);
      await befriend(me, f2);
      await befriend(f1, near);
      await befriend(f2, near);
      await befriend(f1, mid);
      expect(await people(me, "weaver")).toEqual(["weavernear", "weavermid", "weaverfar"]);
      const body = (await find(me, { q: "weaver" })).body.results;
      expect(body.map((u) => u.mutualCount)).toEqual([2, 1, 0]);
      expect(body.map((u) => u.isFriend)).toEqual([false, false, false]);
      expect(far).toBeTruthy();
    });

    it("ranks a friend above a stranger with the same name", async () => {
      const me = await signup(app, "mimi");
      await signup(app, "alikeone", "Alike Person");
      const friend = await signup(app, "alikezed", "Alike Person");
      await befriend(me, friend);
      const results = (await find(me, { q: "alike person" })).body.results;
      expect(results[0].username).toBe("alikezed");
      expect(results[0].isFriend).toBe(true);
    });

    it("keeps to your friends, or to people you have friends in common with, when asked", async () => {
      const me = await signup(app, "mimi");
      const f1 = await signup(app, "fone");
      const mate = await signup(app, "dyermate", "Dyer Mate");
      const second = await signup(app, "dyersecond", "Dyer Second");
      await signup(app, "dyerstranger", "Dyer Stranger");
      await befriend(me, f1);
      await befriend(me, mate);
      await befriend(f1, second);
      await befriend(f1, mate);
      expect((await people(me, "dyer", { connection: "friends" }))).toEqual(["dyermate"]);
      expect((await people(me, "dyer", { connection: "mutual" })).sort()).toEqual(["dyermate", "dyersecond"]);
      expect((await people(me, "dyer", { connection: "any" })).sort()).toEqual(["dyermate", "dyersecond", "dyerstranger"]);
    });

    it("doesn't count friends through someone who keeps their connections private", async () => {
      const me = await signup(app, "mimi");
      const f1 = await signup(app, "fone");
      const target = await signup(app, "knitkim", "Knit Kim");
      await befriend(me, f1);
      await befriend(f1, target);
      expect((await find(me, { q: "knit" })).body.results[0].mutualCount).toBe(1);
      await target.agent.patch("/api/profiles/me").send({ showConnections: false });
      expect((await find(me, { q: "knit" })).body.results[0].mutualCount).toBe(0);
      expect(await people(me, "knit", { connection: "mutual" })).toEqual([]);
      await target.agent.patch("/api/profiles/me").send({ showConnections: true });
      await f1.agent.patch("/api/profiles/me").send({ showConnections: false });
      expect((await find(me, { q: "knit" })).body.results[0].mutualCount).toBe(0);
    });

    it("treats the question as text, not a pattern", async () => {
      const me = await signup(app, "mimi");
      await signup(app, "plainone", "Plain One");
      for (const q of [".*", "(a+)+$", "plain|one", "[a-z]+", "^plain", "\\"]) {
        const res = await find(me, { q });
        expect([200, 400]).toContain(res.status);
        if (res.status === 200) expect(res.body.results).toEqual([]);
      }
    });

    it("lists twenty at a time, up to five pages", { timeout: 120_000 }, async () => {
      const me = await signup(app, "mimi");
      const { User } = M;
      await User.insertMany(Array.from({ length: 45 }, (_, i) => ({ email: `pg${i}@example.com`, username: `pagey${String(i).padStart(2, "0")}`, displayName: `Pagey ${i}`, passwordHash: "x" })));
      const one = (await find(me, { q: "pagey" })).body;
      expect(one.results).toHaveLength(20);
      expect(one.hasMore).toBe(true);
      const two = (await find(me, { q: "pagey", page: 2 })).body;
      expect(two.results).toHaveLength(20);
      const three = (await find(me, { q: "pagey", page: 3 })).body;
      expect(three.results).toHaveLength(5);
      expect(three.hasMore).toBe(false);
      expect(new Set([...one.results, ...two.results, ...three.results].map((u) => u.username)).size).toBe(45);
      expect((await find(me, { q: "pagey", page: 99 })).body.page).toBe(5);
    });

    it("never carries email or anything private", async () => {
      const me = await signup(app, "mimi");
      await signup(app, "emailer", "Emailer");
      const text = JSON.stringify((await find(me, { q: "emailer" })).body);
      expect(text).not.toMatch(/emailer@example.com|passwordHash|emailVerified/);
    });
  });

  describe("blog entries", () => {
    const write = (who, title, body = "Some words about it.") => who.agent.post("/api/blog").send({ title, body });
    const entries = async (who, q) => (await find(who, { q, type: "blog" })).body.results.map((e) => e.title);

    it("finds entries by their title or their words, the title matches first, and shows where it matched", async () => {
      const me = await signup(app, "mimi");
      const writer = await signup(app, "writer");
      await write(writer, "Notes on glaze", "I tried a new recipe for celadon.");
      await write(writer, "Studio week", "This week was all about the glaze again, and a long story about kilns.");
      await write(writer, "Unrelated", "Nothing here");
      const res = (await find(me, { q: "glaze", type: "blog" })).body;
      expect(res.results.map((e) => e.title)).toEqual(["Notes on glaze", "Studio week"]);
      expect(res.results[1].snippet).toContain("glaze");
      expect(res.results[0].author.username).toBe("writer");
      expect(res.results[0].commentCount).toBe(0);
      expect(await entries(me, "glaze celadon")).toEqual(["Notes on glaze"]);
      expect(await entries(me, "glaze nonsenseword")).toEqual([]);
    });

    it("follows the profile rules: private authors are for their friends, blocked and suspended ones are gone", async () => {
      const me = await signup(app, "mimi");
      const open = await signup(app, "openwriter");
      const shy = await signup(app, "shywriter");
      const blocked = await signup(app, "blockedwriter");
      const gone = await signup(app, "suspendedwriter");
      for (const w of [open, shy, blocked, gone]) await write(w, `Entry by ${w.name}`, "marker text");
      await shy.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await blocked.agent.post("/api/users/mimi/block");
      await M.User.updateOne({ _id: gone.user.id }, { suspendedAt: new Date() });
      expect(await entries(me, "marker")).toEqual(["Entry by openwriter"]);
      await befriend(me, shy);
      expect((await entries(me, "marker")).sort()).toEqual(["Entry by openwriter", "Entry by shywriter"]);
      // and your own always show
      await write(me, "My own", "marker too");
      expect(await entries(me, "marker too")).toEqual(["My own"]);
    });

    it("counts the comments on each", async () => {
      const me = await signup(app, "mimi");
      const writer = await signup(app, "writer");
      const id = (await write(writer, "Commented entry", "talk about it")).body.entry.id;
      await me.agent.post(`/api/blog/${id}/comments`).send({ content: "Nice" });
      expect((await find(me, { q: "commented", type: "blog" })).body.results[0].commentCount).toBe(1);
    });
  });

  describe("groups", () => {
    const make = (who, name, description) => who.agent.post("/api/groups").send({ name, description });
    const groups = async (who, q) => (await find(who, { q, type: "groups" })).body.results;

    it("finds groups by name or description, name matches and bigger groups first, and says if you are in one", async () => {
      const me = await signup(app, "mimi");
      const owner = await signup(app, "owner");
      const other = await signup(app, "other");
      const g1 = (await make(owner, "Weekend photographers", "Share what you shot")).body.group;
      await make(owner, "Gear talk", "Cameras and photographers' tricks");
      await make(owner, "Painters", "Oil and acrylic");
      await other.agent.post(`/api/groups/${g1.id}/join`);
      await me.agent.post(`/api/groups/${g1.id}/join`);
      const found = await groups(me, "photographers");
      expect(found.map((g) => g.name)).toEqual(["Weekend photographers", "Gear talk"]);
      expect(found[0].memberCount).toBe(3);
      expect(found[0].isMember).toBe(true);
      expect(found[1].isMember).toBe(false);
      expect(found[1].snippet).toContain("photographers");
      expect(found[0].snippet).toBe("");
      expect((await groups(me, "weekend shot")).map((g) => g.name)).toEqual(["Weekend photographers"]);
    });
  });

  describe("group topics", () => {
    const topics = async (who, q) => (await find(who, { q, type: "topics" })).body.results;

    it("searches only the groups you have joined", async () => {
      const me = await signup(app, "mimi");
      const owner = await signup(app, "owner");
      const joined = (await owner.agent.post("/api/groups").send({ name: "Potters", description: "x" })).body.group;
      const notJoined = (await owner.agent.post("/api/groups").send({ name: "Welders", description: "x" })).body.group;
      await owner.agent.post(`/api/groups/${joined.id}/topics`).send({ title: "Kiln advice", body: "Which kiln should I buy?" });
      await owner.agent.post(`/api/groups/${notJoined.id}/topics`).send({ title: "Kiln chat", body: "Secret kiln talk" });
      expect(await topics(me, "kiln")).toEqual([]); // not in either
      await me.agent.post(`/api/groups/${joined.id}/join`);
      const found = await topics(me, "kiln");
      expect(found.map((t) => t.title)).toEqual(["Kiln advice"]);
      expect(found[0].groupName).toBe("Potters");
      expect(found[0].groupId).toBe(joined.id);
      expect(found[0].author.username).toBe("owner");
      expect(found[0].snippet).toContain("kiln");
      expect(JSON.stringify(found)).not.toContain("Secret");
      await me.agent.post(`/api/groups/${joined.id}/leave`);
      expect(await topics(me, "kiln")).toEqual([]);
    });

    it("leaves out topics started by someone blocked", async () => {
      const me = await signup(app, "mimi");
      const mean = await signup(app, "meanie");
      const g = (await mean.agent.post("/api/groups").send({ name: "Club", description: "x" })).body.group;
      await me.agent.post(`/api/groups/${g.id}/join`);
      await mean.agent.post(`/api/groups/${g.id}/topics`).send({ title: "Banana thoughts", body: "text" });
      expect(await topics(me, "banana")).toHaveLength(1);
      await me.agent.post("/api/users/meanie/block");
      expect(await topics(me, "banana")).toEqual([]);
    });

    it("has nothing to say before you have joined any", async () => {
      const me = await signup(app, "mimi");
      expect((await find(me, { q: "anything", type: "topics" })).body).toMatchObject({ results: [], hasMore: false });
    });
  });

  describe("Help wanted", () => {
    const help = async (who, q) => (await find(who, { q, type: "help" })).body.results;

    it("finds open public requests from other people, and follows the board's rules", async () => {
      const me = await signup(app, "mimi");
      const asker = await signup(app, "asker");
      const shy = await signup(app, "shyasker");
      const blocked = await signup(app, "blockedasker");
      await asker.agent.post("/api/tasks").send({ title: "Need a poster designed", description: "for a gig", isPublic: true });
      await asker.agent.post("/api/tasks").send({ title: "Private poster note", isPublic: false });
      const done = (await asker.agent.post("/api/tasks").send({ title: "Old poster job", isPublic: true })).body;
      await asker.agent.put(`/api/tasks/${done._id}`).send({ done: true });
      await shy.agent.post("/api/tasks").send({ title: "Shy poster request", isPublic: true });
      await shy.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await blocked.agent.post("/api/tasks").send({ title: "Blocked poster request", isPublic: true });
      await blocked.agent.post("/api/users/mimi/block");
      await me.agent.post("/api/tasks").send({ title: "My own poster", isPublic: true });

      const found = await help(me, "poster");
      expect(found.map((t) => t.title)).toEqual(["Need a poster designed"]);
      expect(found[0].author.username).toBe("asker");
      expect((await help(me, "gig")).map((t) => t.title)).toEqual(["Need a poster designed"]);
      await befriend(me, shy);
      expect((await help(me, "poster")).map((t) => t.title).sort()).toEqual(["Need a poster designed", "Shy poster request"]);
    });
  });
});
