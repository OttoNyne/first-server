import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.122.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("open calls", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      Call: (await import("../models/Call.js")).Call,
      CallApplication: (await import("../models/CallApplication.js")).CallApplication,
      Notification: (await import("../models/Notification.js")).Notification,
      User: (await import("../models/User.js")).User,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const NEW = { title: "Vocalist for an EP", details: "Looking for a warm alto for three songs.", lookingFor: ["Vocalist", "singer"] };
  const post = (who, body = NEW) => who.agent.post("/api/calls").send(body);
  const make = async (who, body = NEW) => (await post(who, body)).body.call;
  const offer = (who, { offers = [], tags = [], open = true } = {}) => who.agent.patch("/api/profiles/me").send({ workOffers: offers, tags, openToWork: open });
  const befriend = async (a, b) => {
    const { friendship } = (await a.agent.post(`/api/friends/request/${b.user.username}`)).body;
    await b.agent.post(`/api/friends/accept/${friendship._id}`);
  };
  const board = async (who, query = "") => (await who.agent.get(`/api/calls${query}`)).body;
  const piece = async (who) => (await who.agent.post("/api/media").send({ type: "image", url: "https://img.example.com/p.png", caption: "My work" })).body.mediaItem;
  const noticesOf = (who, type) => M.Notification.find({ recipient: who.user.id, type });

  describe("posting", () => {
    it("posts a call, cleaning the roles into tags", async () => {
      const zoe = await signup(app, "zoe");
      const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const res = await post(zoe, { ...NEW, budget: " unpaid, credit ", deadline: soon });
      expect(res.status).toBe(201);
      expect(res.body.call).toMatchObject({ title: "Vocalist for an EP", lookingFor: ["vocalist", "singer"], budget: "unpaid, credit", deadline: soon, status: "open", closed: false, mine: true });
      expect(res.body.call.owner.username).toBe("zoe");
    });

    it("needs a title and what it is looking for, and checks every field", async () => {
      const zoe = await signup(app, "zoe");
      const bad = [
        { ...NEW, title: "" },
        { ...NEW, title: "x".repeat(81) },
        { ...NEW, details: "  " },
        { ...NEW, details: "x".repeat(1501) },
        { ...NEW, lookingFor: "vocalist" },
        { ...NEW, lookingFor: [5] },
        { ...NEW, lookingFor: ["a"] },
        { ...NEW, lookingFor: ["a", "bb", "cc", "dd", "ee", "ff"].map((r, i) => `role${i}`) },
        { ...NEW, budget: "x".repeat(41) },
        { ...NEW, budget: 5 },
        { ...NEW, deadline: "yesterday" },
        { ...NEW, deadline: "2001-01-01" },
      ];
      for (const body of bad) expect((await post(zoe, body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((await post(zoe, { title: "No roles needed", details: "Anyone can answer" })).status).toBe(201);
      expect((await request(app).post("/api/calls").send(NEW)).status).toBe(401);
    });

    it("allows five open calls at a time, and a closed one makes room", async () => {
      const zoe = await signup(app, "zoe");
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await make(zoe, { ...NEW, title: `Call ${i}` })).id);
      const sixth = await post(zoe, { ...NEW, title: "Sixth" });
      expect(sixth.status).toBe(409);
      expect(sixth.body.error).toMatch(/up to 5 open calls/);
      await zoe.agent.patch(`/api/calls/${ids[0]}`).send({ status: "closed" });
      expect((await post(zoe, { ...NEW, title: "Sixth" })).status).toBe(201);
    });

    it("limits how many a person can post in a day", async () => {
      const zoe = await signup(app, "zoe");
      await M.RateLimitHit.insertMany(Array.from({ length: 10 }, () => ({ key: `call-create:${zoe.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
      expect((await post(zoe)).status).toBe(429);
    });
  });

  describe("the board", () => {
    it("shows other people's open calls, newest first, and not your own", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      await make(zoe, { ...NEW, title: "Older" });
      await make(zoe, { ...NEW, title: "Newer" });
      await make(kai, { ...NEW, title: "Kai's own" });
      expect((await board(kai)).calls.map((c) => c.title)).toEqual(["Newer", "Older"]);
      expect((await board(zoe)).calls.map((c) => c.title)).toEqual(["Kai's own"]);
    });

    it("leaves out closed calls and ones whose last day has passed, but not today's", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const closed = await make(zoe, { ...NEW, title: "Closed" });
      const past = await make(zoe, { ...NEW, title: "Past" });
      const today = await make(zoe, { ...NEW, title: "Today" });
      await make(zoe, { ...NEW, title: "Open" });
      await zoe.agent.patch(`/api/calls/${closed.id}`).send({ status: "closed" });
      await M.Call.updateOne({ _id: past.id }, { $set: { deadline: new Date(Date.now() - 3 * 86400000) } });
      await M.Call.updateOne({ _id: today.id }, { $set: { deadline: new Date(Math.floor(Date.now() / 86400000) * 86400000) } });
      expect((await board(kai)).calls.map((c) => c.title).sort()).toEqual(["Open", "Today"]);
    });

    it("keeps out calls from people the viewer can't see: blocked, private, muted", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const ann = await signup(app, "ann");
      await make(zoe, { ...NEW, title: "From zoe" });
      await make(liv, { ...NEW, title: "From liv" });
      await make(ann, { ...NEW, title: "From ann" });
      await zoe.agent.post("/api/users/kai/block");
      await liv.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await kai.agent.put("/api/mutes/people/ann");
      expect((await board(kai)).calls).toEqual([]);
      // a friend sees a private person's call
      await befriend(liv, kai);
      expect((await board(kai)).calls.map((c) => c.title)).toEqual(["From liv"]);
    });

    it("marks the calls that fit what you offer, and can show only those", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      await make(zoe, { title: "Singer", details: "d", lookingFor: ["vocalist"] });
      await make(zoe, { title: "Painter", details: "d", lookingFor: ["oil painting"] });
      await make(zoe, { title: "Anyone", details: "d" });
      await offer(kai, { offers: ["vocalist", "mixing"] });
      const all = (await board(kai)).calls;
      expect(Object.fromEntries(all.map((c) => [c.title, c.match]))).toEqual({ Singer: ["vocalist"], Painter: [], Anyone: [] });
      expect((await board(kai, "?for=me")).calls.map((c) => c.title)).toEqual(["Singer"]);
      expect((await board(kai, "?tag=oil%20painting")).calls.map((c) => c.title)).toEqual(["Painter"]);
    });

    it("matches a role that shares a word, in offers or tags", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      await make(zoe, { title: "Logos", details: "d", lookingFor: ["logo design"] });
      await offer(kai, { tags: ["logo"] });
      expect((await board(kai, "?for=me")).calls.map((c) => c.title)).toEqual(["Logos"]);
    });

    it("pages with a cursor", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const id = (await M.User.findOne({ username: "zoe" }))._id;
      await M.Call.insertMany(Array.from({ length: 25 }, (_, i) => ({ owner: id, title: `Call ${String(i).padStart(2, "0")}`, details: "d" })));
      const first = await board(kai);
      expect(first.calls).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      const second = await board(kai, `?before=${first.next}`);
      expect(second.calls).toHaveLength(5);
      expect(second.hasMore).toBe(false);
    });

    it("says which calls you have applied to", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const call = await make(zoe);
      await make(zoe, { ...NEW, title: "Other" });
      await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "Me!" });
      const list = (await board(kai)).calls;
      expect(Object.fromEntries(list.map((c) => [c.title, c.applied]))).toEqual({ "Vocalist for an EP": "waiting", Other: null });
    });
  });

  describe("one call", () => {
    it("shows the owner their counts, and others how they fit and whether they applied", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const call = await make(zoe);
      await offer(kai, { offers: ["singer"] });
      await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "Hello" });
      const mine = (await zoe.agent.get(`/api/calls/${call.id}`)).body.call;
      expect(mine).toMatchObject({ mine: true, applicantCount: 1, waitingCount: 1 });
      const theirs = (await kai.agent.get(`/api/calls/${call.id}`)).body.call;
      expect(theirs).toMatchObject({ mine: false, match: ["singer"], applied: "waiting", myApplication: { note: "Hello", status: "waiting" } });
      expect(theirs.applicantCount).toBeUndefined();
    });

    it("answers 404 where the owner can't be seen, and for a missing or malformed id", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const call = await make(zoe);
      expect((await kai.agent.get("/api/calls/64b64b64b64b64b64b64b64b")).status).toBe(404);
      expect((await kai.agent.get("/api/calls/nope")).status).toBe(404);
      await zoe.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await kai.agent.get(`/api/calls/${call.id}`)).status).toBe(404);
      expect((await zoe.agent.get(`/api/calls/${call.id}`)).status).toBe(200);
      expect((await request(app).get(`/api/calls/${call.id}`)).status).toBe(401);
    });
  });

  describe("changing and closing", () => {
    it("changes what was sent and nothing else, and only for the owner", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const call = await make(zoe);
      const res = await zoe.agent.patch(`/api/calls/${call.id}`).send({ title: "A better title", lookingFor: ["alto"] });
      expect(res.status).toBe(200);
      expect(res.body.call).toMatchObject({ title: "A better title", lookingFor: ["alto"], details: NEW.details });
      expect((await zoe.agent.patch(`/api/calls/${call.id}`).send({})).status).toBe(400);
      expect((await zoe.agent.patch(`/api/calls/${call.id}`).send({ title: "" })).status).toBe(400);
      expect((await zoe.agent.patch(`/api/calls/${call.id}`).send({ status: "paused" })).status).toBe(400);
      expect((await kai.agent.patch(`/api/calls/${call.id}`).send({ title: "Mine now" })).status).toBe(404);
    });

    it("closes and reopens, but not after the last day", async () => {
      const zoe = await signup(app, "zoe");
      const call = await make(zoe);
      const closed = await zoe.agent.patch(`/api/calls/${call.id}`).send({ status: "closed" });
      expect(closed.body.call).toMatchObject({ status: "closed", closed: true });
      expect((await zoe.agent.patch(`/api/calls/${call.id}`).send({ status: "open" })).body.call.closed).toBe(false);
      await zoe.agent.patch(`/api/calls/${call.id}`).send({ status: "closed" });
      await M.Call.updateOne({ _id: call.id }, { $set: { deadline: new Date(Date.now() - 3 * 86400000) } });
      const late = await zoe.agent.patch(`/api/calls/${call.id}`).send({ status: "open" });
      expect(late.status).toBe(400);
      expect(late.body.error).toMatch(/deadline has passed/);
    });

    it("deletes a call with its applications and notices", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const call = await make(zoe);
      await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "Me" });
      expect(await noticesOf(zoe, "call_application")).toHaveLength(1);
      expect((await kai.agent.delete(`/api/calls/${call.id}`)).status).toBe(404);
      expect((await zoe.agent.delete(`/api/calls/${call.id}`)).status).toBe(204);
      expect(await M.Call.countDocuments({})).toBe(0);
      expect(await M.CallApplication.countDocuments({})).toBe(0);
      expect(await noticesOf(zoe, "call_application")).toHaveLength(0);
    });
  });

  describe("applying", () => {
    it("applies with words and one of your own pieces, and the owner is told", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const call = await make(zoe);
      const mine = await piece(kai);
      const res = await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "  I sing alto  ", piece: mine.id });
      expect(res.status).toBe(201);
      const notices = await noticesOf(zoe, "call_application");
      expect(notices).toHaveLength(1);
      expect(notices[0].payload).toMatchObject({ actorId: kai.user.id, callId: call.id, title: NEW.title });
      const list = (await zoe.agent.get(`/api/calls/${call.id}/applications`)).body.applications;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ note: "I sing alto", status: "waiting", applicant: { username: "kai" }, piece: { id: mine.id, caption: "My work" } });
    });

    it("takes a piece alone, or words alone, but not nothing", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const call = await make(zoe);
      expect((await kai.agent.post(`/api/calls/${call.id}/apply`).send({})).status).toBe(400);
      expect((await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "  " })).status).toBe(400);
      const mine = await piece(kai);
      expect((await kai.agent.post(`/api/calls/${call.id}/apply`).send({ piece: mine.id })).status).toBe(201);
      expect((await liv.agent.post(`/api/calls/${call.id}/apply`).send({ note: "Words only" })).status).toBe(201);
    });

    it("refuses someone else's piece, a made-up one, and a note that is too long", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const call = await make(zoe);
      const hers = await piece(zoe);
      expect((await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "x", piece: hers.id })).status).toBe(400);
      expect((await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "x", piece: "nope" })).status).toBe(400);
      expect((await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "x".repeat(501) })).status).toBe(400);
      expect((await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: 5 })).status).toBe(400);
      expect(await M.CallApplication.countDocuments({})).toBe(0);
    });

    it("refuses applying twice, to your own call, to a closed one, and to one you can't see", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const call = await make(zoe);
      expect((await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "once" })).status).toBe(201);
      expect((await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "twice" })).status).toBe(409);
      expect((await zoe.agent.post(`/api/calls/${call.id}/apply`).send({ note: "me" })).status).toBe(400);
      await zoe.agent.post("/api/users/liv/block");
      expect((await liv.agent.post(`/api/calls/${call.id}/apply`).send({ note: "x" })).status).toBe(404);
      await zoe.agent.patch(`/api/calls/${call.id}`).send({ status: "closed" });
      const ann = await signup(app, "ann");
      const late = await ann.agent.post(`/api/calls/${call.id}/apply`).send({ note: "x" });
      expect(late.status).toBe(409);
      expect(late.body.error).toBe("This call is closed");
    });

    it("stops at a hundred applications", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const call = await make(zoe);
      await M.CallApplication.insertMany(Array.from({ length: 100 }, () => ({ call: call.id, applicant: new M.User()._id, note: "x" })));
      const res = await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "late" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/enough applications/);
    });

    it("withdraws an application that is still waiting, and not an answered one", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const call = await make(zoe);
      await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "x" });
      await liv.agent.post(`/api/calls/${call.id}/apply`).send({ note: "y" });
      expect((await kai.agent.delete(`/api/calls/${call.id}/apply`)).status).toBe(204);
      expect(await noticesOf(zoe, "call_application")).toHaveLength(1);
      const apps = (await zoe.agent.get(`/api/calls/${call.id}/applications`)).body.applications;
      await zoe.agent.post(`/api/calls/${call.id}/applications/${apps[0].id}/answer`).send({ choose: false });
      expect((await liv.agent.delete(`/api/calls/${call.id}/apply`)).status).toBe(409);
      expect((await kai.agent.delete(`/api/calls/${call.id}/apply`)).status).toBe(404);
    });

    it("lists what you applied to", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const call = await make(zoe);
      await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "x" });
      const list = (await kai.agent.get("/api/calls/applied")).body.applications;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ status: "waiting", call: { title: NEW.title, owner: { username: "zoe" } } });
      expect((await zoe.agent.get("/api/calls/applied")).body.applications).toEqual([]);
    });
  });

  describe("answering", () => {
    it("chooses or passes with a note, and the applicant is told", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const call = await make(zoe);
      await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "x" });
      await liv.agent.post(`/api/calls/${call.id}/apply`).send({ note: "y" });
      const apps = (await zoe.agent.get(`/api/calls/${call.id}/applications`)).body.applications;
      const kaisApp = apps.find((a) => a.applicant.username === "kai");
      const livsApp = apps.find((a) => a.applicant.username === "liv");
      const chose = await zoe.agent.post(`/api/calls/${call.id}/applications/${kaisApp.id}/answer`).send({ choose: true, reply: "Let's talk" });
      expect(chose.body.application).toMatchObject({ status: "chosen", reply: "Let's talk" });
      await zoe.agent.post(`/api/calls/${call.id}/applications/${livsApp.id}/answer`).send({ choose: false });
      expect((await noticesOf(kai, "call_answer"))[0].payload).toMatchObject({ callId: call.id, chosen: true });
      expect((await noticesOf(liv, "call_answer"))[0].payload.chosen).toBe(false);
      expect((await kai.agent.get(`/api/calls/${call.id}`)).body.call.myApplication).toMatchObject({ status: "chosen", reply: "Let's talk" });
      // the owner's notices about them are cleared
      expect(await noticesOf(zoe, "call_application")).toHaveLength(0);
    });

    it("answers once, with a yes or no and a short note, and only for the owner", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const call = await make(zoe);
      await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "x" });
      const [first] = (await zoe.agent.get(`/api/calls/${call.id}/applications`)).body.applications;
      const answer = (who, body) => who.agent.post(`/api/calls/${call.id}/applications/${first.id}/answer`).send(body);
      expect((await answer(kai, { choose: true })).status).toBe(404);
      expect((await answer(zoe, {})).status).toBe(400);
      expect((await answer(zoe, { choose: "yes" })).status).toBe(400);
      expect((await answer(zoe, { choose: true, reply: "x".repeat(301) })).status).toBe(400);
      expect((await answer(zoe, { choose: true })).status).toBe(200);
      expect((await answer(zoe, { choose: false })).status).toBe(409);
    });

    it("lets only the owner see who applied, and leaves out people blocked either way", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const call = await make(zoe);
      await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "x" });
      await liv.agent.post(`/api/calls/${call.id}/apply`).send({ note: "y" });
      expect((await kai.agent.get(`/api/calls/${call.id}/applications`)).status).toBe(404);
      await zoe.agent.post("/api/users/liv/block");
      expect((await zoe.agent.get(`/api/calls/${call.id}/applications`)).body.applications.map((a) => a.applicant.username)).toEqual(["kai"]);
    });
  });

  describe("people who might fit", () => {
    it("suggests people open to work with something in common, best fit first, and tells them about a new call", async () => {
      const zoe = await signup(app, "zoe");
      const both = await signup(app, "both");
      const one = await signup(app, "one");
      const closed = await signup(app, "closed");
      const none = await signup(app, "none");
      await offer(both, { offers: ["vocalist", "singer"] });
      await offer(one, { tags: ["Singer"] });
      await offer(closed, { offers: ["vocalist"], open: false });
      await offer(none, { offers: ["welding"] });
      const call = await make(zoe);
      const people = (await zoe.agent.get(`/api/calls/${call.id}/matches`)).body.people;
      expect(people.map((p) => p.username)).toEqual(["both", "one"]);
      expect(people[0].matched).toEqual(["vocalist", "singer"]);
      expect(people[1].matched).toEqual(["singer"]);
      // the same people were told, and nobody else
      expect((await noticesOf(both, "call_match")).length).toBe(1);
      expect((await noticesOf(one, "call_match")).length).toBe(1);
      expect(await noticesOf(closed, "call_match")).toHaveLength(0);
      expect(await noticesOf(none, "call_match")).toHaveLength(0);
      expect(await noticesOf(zoe, "call_match")).toHaveLength(0);
      expect((await noticesOf(both, "call_match"))[0].payload).toMatchObject({ callId: call.id, actorId: zoe.user.id });
    });

    it("leaves out applicants, blocked people, private strangers and people who muted the owner", async () => {
      const zoe = await signup(app, "zoe");
      const applicant = await signup(app, "applicant");
      const blocked = await signup(app, "blocked");
      const hidden = await signup(app, "hidden");
      const friend = await signup(app, "friend");
      const quiet = await signup(app, "quiet");
      for (const p of [applicant, blocked, hidden, friend, quiet]) await offer(p, { offers: ["vocalist"] });
      await hidden.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await friend.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await befriend(zoe, friend);
      await zoe.agent.post("/api/users/blocked/block");
      await quiet.agent.put("/api/mutes/people/zoe");
      const call = await make(zoe, { ...NEW, lookingFor: ["vocalist"] });
      await applicant.agent.post(`/api/calls/${call.id}/apply`).send({ note: "x" });
      const people = (await zoe.agent.get(`/api/calls/${call.id}/matches`)).body.people.map((p) => p.username).sort();
      expect(people).toEqual(["friend", "quiet"]); // quiet muted zoe but can still be suggested to her; only the notice is held back
      expect(await noticesOf(quiet, "call_match")).toHaveLength(0);
      expect(await noticesOf(friend, "call_match")).toHaveLength(1);
      expect(await noticesOf(hidden, "call_match")).toHaveLength(0);
      expect(await noticesOf(blocked, "call_match")).toHaveLength(0);
    });

    it("tells at most twenty people, and shows only the owner the suggestions", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const ids = Array.from({ length: 30 }, () => new M.User()._id);
      await M.User.insertMany(ids.map((_id, i) => ({ _id, email: `p${i}@example.com`, username: `p${i}`, passwordHash: "x", displayName: `P${i}`, openToWork: true, workOffers: ["vocalist"] })));
      const call = await make(zoe, { ...NEW, lookingFor: ["vocalist"] });
      expect(await M.Notification.countDocuments({ type: "call_match" })).toBe(20);
      expect((await zoe.agent.get(`/api/calls/${call.id}/matches`)).body.people).toHaveLength(12);
      expect((await kai.agent.get(`/api/calls/${call.id}/matches`)).status).toBe(404);
    });

    it("suggests nobody when the call looks for no one in particular", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      await offer(kai, { offers: ["vocalist"] });
      const call = await make(zoe, { title: "Anyone", details: "d" });
      expect((await zoe.agent.get(`/api/calls/${call.id}/matches`)).body.people).toEqual([]);
      expect(await M.Notification.countDocuments({ type: "call_match" })).toBe(0);
    });
  });

  describe("tidying up", () => {
    it("takes a person's calls and applications away with their account, and lists them in the data download", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const call = await make(zoe);
      const kaisCall = await make(kai, { ...NEW, title: "Kai's call" });
      await kai.agent.post(`/api/calls/${call.id}/apply`).send({ note: "Hello" });
      await zoe.agent.post(`/api/calls/${kaisCall.id}/apply`).send({ note: "Hi back" });
      const data = JSON.parse((await kai.agent.post("/api/profiles/me/export").send({ password: "password123" })).text);
      expect(data.openCalls.map((c) => c.title)).toEqual(["Kai's call"]);
      expect(data.callApplications).toHaveLength(1);
      expect(data.callApplications[0]).toMatchObject({ callTitle: NEW.title, note: "Hello", status: "waiting" });
      expect((await kai.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await M.Call.countDocuments({})).toBe(1);
      expect(await M.CallApplication.countDocuments({})).toBe(0);
    });
  });
});
