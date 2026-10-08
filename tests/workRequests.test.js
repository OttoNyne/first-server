import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { checkDeadline } from "../routes/workRequests.routes.js";
import { checkOffers } from "../utils/profileFields.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.109.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const BRIEF = { title: "A logo for my bakery", details: "Warm colours, hand-drawn feel.", budget: "around 200", deadline: future(60) };

describe("checking what goes into a request", () => {
  it("deadlines are real days, not in the past and at most two years ahead; none is fine", () => {
    expect(checkDeadline(undefined)).toEqual({ value: null });
    expect(checkDeadline("")).toEqual({ value: null });
    expect(checkDeadline(future(30)).value).toBeInstanceOf(Date);
    for (const bad of ["tomorrow", "2026-13-40", "2026-02-30", 5, {}, "2020-01-01", future(800)]) expect(checkDeadline(bad).error, String(bad)).toBeTruthy();
  });
  it("offers are a short list of tag-like words", () => {
    expect(checkOffers(["Logo Design", " mixing ", "logo design"]).value).toEqual(["logo design", "mixing"]);
    for (const bad of ["x", [1], ["!!"], ["a", "b", "c", "d", "e", "f"].map((s) => s + s), [{}]]) expect(checkOffers(bad).error, JSON.stringify(bad)).toBeTruthy();
  });
});

describe("open to work and requests for work", () => {
  let app, WorkRequest, Notification, User;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ WorkRequest } = await import("../models/WorkRequest.js"));
    ({ Notification } = await import("../models/Notification.js"));
    ({ User } = await import("../models/User.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const openUp = (who, over = {}) => who.agent.patch("/api/profiles/me").send({ openToWork: true, workOffers: ["Logo design", "illustration"], workNote: "Booked until March", ...over });
  const ask = (who, to, over = {}) => who.agent.post(`/api/work-requests/to/${to}`).send({ ...BRIEF, ...over });
  async function pair() {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    await openUp(alice);
    return { alice, bob };
  }

  describe("saying you are open to work", () => {
    it("is off by default, and a person turns it on with what they offer and a note", async () => {
      const alice = await signup(app, "alice");
      expect(alice.user.openToWork).toBe(false);
      const res = await openUp(alice);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ openToWork: true, workOffers: ["logo design", "illustration"], workNote: "Booked until March" });
      expect((await request(app).get("/api/profiles/alice")).body.user).toMatchObject({ openToWork: true, workOffers: ["logo design", "illustration"] });
    });

    it("refuses anything that isn't a yes or no, a short list, and a one-line note", async () => {
      const alice = await signup(app, "alice");
      for (const body of [{ openToWork: "yes" }, { openToWork: 1 }, { workOffers: "logo" }, { workOffers: [1] }, { workOffers: ["a-valid", "!!"] }, { workNote: 5 }, { workNote: "x".repeat(141) }]) {
        expect((await alice.agent.patch("/api/profiles/me").send(body)).status, JSON.stringify(body)).toBe(400);
      }
      expect((await alice.agent.get("/api/auth/me")).body.user.openToWork).toBe(false);
    });

    it("can be found in people search, which can keep to those open to work", async () => {
      const { alice, bob } = await pair();
      await signup(app, "alisa"); // not open
      const all = await bob.agent.get("/api/search?q=ali&type=people");
      expect(all.body.results.map((r) => r.user?.username ?? r.username).sort()).toEqual(["alice", "alisa"]);
      const open = await bob.agent.get("/api/search?q=ali&type=people&open=1");
      expect(open.body.results.map((r) => r.user?.username ?? r.username)).toEqual(["alice"]);
      expect((await bob.agent.get("/api/search?q=ali&type=people&open=yes")).status).toBe(400);
      expect((await bob.agent.get("/api/search?q=ali&type=blog&open=1")).status).toBe(400);
      expect(alice.user.id).toBeTruthy();
    });
  });

  describe("asking", () => {
    it("sends a request to someone open to work, and tells them", async () => {
      const { alice, bob } = await pair();
      const res = await ask(bob, "alice");
      expect(res.status).toBe(201);
      expect(res.body.request).toMatchObject({ title: "A logo for my bakery", status: "open", budget: "around 200" });
      const note = await Notification.findOne({ recipient: alice.user.id, type: "work_request" });
      expect(note.payload).toMatchObject({ actorId: bob.user.id, title: "A logo for my bakery" });
    });

    it("needs a sign-in, and gives the same answer for everyone who can't be asked", async () => {
      const { alice, bob } = await pair();
      const closed = await signup(app, "closed");
      const priv = await signup(app, "priv");
      await openUp(priv);
      await priv.agent.patch("/api/profiles/me").send({ isPrivate: true });
      const suspended = await signup(app, "suspended");
      await openUp(suspended);
      await User.updateOne({ username: "suspended" }, { suspendedAt: new Date() });
      const blocker = await signup(app, "blocker");
      await openUp(blocker);
      await blocker.agent.post("/api/users/bob/block");
      expect((await request(app).post("/api/work-requests/to/alice").send(BRIEF)).status).toBe(401);
      const answers = [];
      for (const name of ["closed", "priv", "suspended", "blocker", "nobody-here"]) answers.push(await ask(bob, name));
      expect(answers.map((a) => a.status)).toEqual([404, 404, 404, 404, 404]);
      expect(new Set(answers.map((a) => a.body.error)).size).toBe(1);
      expect(await WorkRequest.countDocuments()).toBe(0);
      expect(closed.user.id && alice.user.id).toBeTruthy();
    });

    it("lets a friend of a private profile ask", async () => {
      const { alice, bob } = await pair();
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await ask(bob, "alice")).status).toBe(404);
      const sent = await bob.agent.post("/api/friends/request/alice");
      await alice.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
      expect((await ask(bob, "alice")).status).toBe(201);
    });

    it("can't be sent to yourself", async () => {
      const { alice } = await pair();
      expect((await ask(alice, "alice")).status).toBe(400);
    });

    it("checks the brief: a title, what is needed, short budget, a sensible deadline", async () => {
      const { bob } = await pair();
      const cases = [
        { title: "" }, { title: "   " }, { title: 5 }, { title: "x".repeat(81) },
        { details: "" }, { details: 5 }, { details: "x".repeat(1001) },
        { budget: 5 }, { budget: "x".repeat(41) },
        { deadline: "next week" }, { deadline: "2020-01-01" },
      ];
      for (const over of cases) expect((await ask(bob, "alice", over)).status, JSON.stringify(over)).toBe(400);
      expect((await ask(bob, "alice", { budget: undefined, deadline: undefined })).status).toBe(201);
    });

    it("limits waiting requests to one person (2), and requests a day (5)", async () => {
      const { alice, bob } = await pair();
      expect((await ask(bob, "alice")).status).toBe(201);
      expect((await ask(bob, "alice")).status).toBe(201);
      expect((await ask(bob, "alice")).status).toBe(409);
      for (const name of ["pone", "ptwo", "pthree"]) {
        const other = await signup(app, name);
        await openUp(other);
        expect((await ask(bob, name)).status).toBe(201);
      }
      const last = await signup(app, "pfour");
      await openUp(last);
      expect((await ask(bob, "pfour")).status).toBe(429);
      expect(alice.user.id).toBeTruthy();
    });
  });

  describe("answering", () => {
    async function asked() {
      const { alice, bob } = await pair();
      const id = (await ask(bob, "alice")).body.request.id;
      return { alice, bob, id };
    }

    it("lists what was asked, to the person asked only, and the asker sees it as sent", async () => {
      const { alice, bob, id } = await asked();
      const mine = await alice.agent.get("/api/work-requests/received");
      expect(mine.body.requests).toHaveLength(1);
      expect(mine.body.requests[0]).toMatchObject({ id, status: "open", from: { username: "bob" } });
      expect((await bob.agent.get("/api/work-requests/received")).body.requests).toEqual([]);
      expect((await bob.agent.get("/api/work-requests/sent")).body.requests[0]).toMatchObject({ id, to: { username: "alice" } });
      expect((await alice.agent.get("/api/work-requests/sent")).body.requests).toEqual([]);
      expect((await request(app).get("/api/work-requests/received")).status).toBe(401);
    });

    it("accepts or declines with a note, once, and tells the asker", async () => {
      const { alice, bob, id } = await asked();
      expect((await bob.agent.post(`/api/work-requests/${id}/answer`).send({ accept: true })).status).toBe(404); // only the person asked
      const bad = await alice.agent.post(`/api/work-requests/${id}/answer`).send({ accept: "yes" });
      expect(bad.status).toBe(400);
      expect((await alice.agent.post(`/api/work-requests/${id}/answer`).send({ accept: true, reply: "x".repeat(501) })).status).toBe(400);
      const ok = await alice.agent.post(`/api/work-requests/${id}/answer`).send({ accept: true, reply: "  Happy to — message me  " });
      expect(ok.status).toBe(200);
      expect(ok.body.request).toMatchObject({ status: "accepted", reply: "Happy to — message me" });
      expect((await alice.agent.post(`/api/work-requests/${id}/answer`).send({ accept: false })).status).toBe(409);
      expect(await Notification.countDocuments({ type: "work_request" })).toBe(0);
      const reply = await Notification.findOne({ recipient: bob.user.id, type: "work_reply" });
      expect(reply.payload).toMatchObject({ actorId: alice.user.id, accepted: true });
      expect((await bob.agent.get("/api/work-requests/sent")).body.requests[0]).toMatchObject({ status: "accepted", reply: "Happy to — message me" });
    });

    it("hides requests from people who have been blocked, or are suspended", async () => {
      const { alice, bob } = await pair();
      const dan = await signup(app, "dan");
      await ask(bob, "alice");
      await ask(dan, "alice");
      await alice.agent.post("/api/users/dan/block");
      await User.updateOne({ username: "bob" }, { suspendedAt: new Date() });
      expect((await alice.agent.get("/api/work-requests/received")).body.requests).toEqual([]);
    });

    it("is withdrawn by the asker while waiting, and cleared by the person asked once answered", async () => {
      const { alice, bob, id } = await asked();
      expect((await alice.agent.delete(`/api/work-requests/${id}`)).status).toBe(409); // answer it first
      expect((await bob.agent.delete(`/api/work-requests/${id}`)).status).toBe(204);
      expect(await Notification.countDocuments({ type: "work_request" })).toBe(0);
      const second = (await ask(bob, "alice")).body.request.id;
      await alice.agent.post(`/api/work-requests/${second}/answer`).send({ accept: false });
      expect((await bob.agent.delete(`/api/work-requests/${second}`)).status).toBe(409); // answered: too late to withdraw
      expect((await alice.agent.delete(`/api/work-requests/${second}`)).status).toBe(204);
      expect(await WorkRequest.countDocuments()).toBe(0);
      expect((await alice.agent.delete("/api/work-requests/not-an-id")).status).toBe(404);
    });
  });

  describe("when things go away", () => {
    it("removes a person's requests, both ways, with their account, and lists them in the download", async () => {
      const { alice, bob } = await pair();
      await ask(bob, "alice");
      const { buildExport } = await import("../services/dataExport.js");
      const theirs = await buildExport(bob.user.id);
      expect(theirs.workRequests.youSent).toEqual([expect.objectContaining({ to: "alice", title: "A logo for my bakery", status: "open" })]);
      const mine = await buildExport(alice.user.id);
      expect(mine.account).toMatchObject({ openToWork: true, workOffers: ["logo design", "illustration"] });
      expect((await bob.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await WorkRequest.countDocuments()).toBe(0);
    });
  });
});
