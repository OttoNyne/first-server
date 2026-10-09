import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

const outbox = [];
vi.mock("../utils/mailer.js", () => ({
  mailAvailable: () => true,
  sendMail: vi.fn(async (mail) => {
    outbox.push(mail);
    return { sent: true };
  }),
}));

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.125.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("following topics and the weekly summary", () => {
  let app, M, digest, routeDigest;
  beforeAll(async () => {
    process.env.CLIENT_URL = "https://www.example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    digest = await import("../services/digest.js");
    routeDigest = await import("../routes/digest.routes.js");
    M = {
      User: (await import("../models/User.js")).User,
      Post: (await import("../models/Post.js")).Post,
      TagFollow: (await import("../models/TagFollow.js")).TagFollow,
      Notification: (await import("../models/Notification.js")).Notification,
      Follow: (await import("../models/Follow.js")).Follow,
      Call: (await import("../models/Call.js")).Call,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    outbox.length = 0;
    routeDigest.resetDigestRun();
  });
  afterAll(async () => {
    delete process.env.CLIENT_URL;
    await clearTestDb();
    await disconnectTestDb();
  });

  const say = (who, content) => who.agent.post("/api/posts").send({ content });
  const follow = (who, tag) => who.agent.put(`/api/topics/${encodeURIComponent(tag)}`);
  const mine = async (who, query = "") => (await who.agent.get(`/api/explore?mine=1${query}`)).body;

  describe("following topics", () => {
    it("follows and unfollows a topic, in a normal form, once however many times", async () => {
      const zoe = await signup(app, "zoe");
      expect((await follow(zoe, "#Clay")).status).toBe(201);
      expect((await follow(zoe, "clay")).status).toBe(200);
      expect((await follow(zoe, "glaze")).status).toBe(201);
      expect((await zoe.agent.get("/api/topics")).body.topics).toEqual(["glaze", "clay"]);
      expect((await zoe.agent.delete("/api/topics/CLAY")).status).toBe(204);
      expect((await zoe.agent.delete("/api/topics/clay")).status).toBe(204);
      expect((await zoe.agent.get("/api/topics")).body.topics).toEqual(["glaze"]);
    });

    it("refuses what can't be a topic, a thirty-first, and signed-out visitors", async () => {
      const zoe = await signup(app, "zoe");
      for (const bad of ["a", "has space", "x".repeat(31), "12345", "<b>"]) expect((await follow(zoe, bad)).status, bad).toBe(400);
      const id = (await M.User.findOne({ username: "zoe" }))._id;
      await M.TagFollow.insertMany(Array.from({ length: 30 }, (_, i) => ({ user: id, tag: `topic${i}x` })));
      const full = await follow(zoe, "onemore");
      expect(full.status).toBe(400);
      expect(full.body.error).toMatch(/up to 30 topics/);
      expect((await request(app).get("/api/topics")).status).toBe(401);
      expect((await request(app).put("/api/topics/clay")).status).toBe(401);
    });

    it("keeps each person's topics to themselves", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      await follow(zoe, "clay");
      expect((await kai.agent.get("/api/topics")).body.topics).toEqual([]);
    });
  });

  describe("what is posted about them", () => {
    it("shows public posts and pieces about the topics you follow, and nothing else", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      await say(kai, "Throwing a vase #clay");
      await say(kai, "Painting a wall #murals");
      await say(kai, "No tag at all");
      await kai.agent.post("/api/media").send({ type: "image", url: "https://img.example.com/a.png", caption: "A glazed bowl #glaze" });
      await follow(zoe, "clay");
      await follow(zoe, "glaze");
      expect((await mine(zoe)).posts.map((p) => p.content)).toEqual(["Throwing a vase #clay"]);
      expect((await mine(zoe, "&type=pieces")).pieces.map((p) => p.item.caption)).toEqual(["A glazed bowl #glaze"]);
    });

    it("leaves out people who are private, blocked or muted, as everywhere", async () => {
      const zoe = await signup(app, "zoe");
      const hidden = await signup(app, "hidden");
      const blocked = await signup(app, "blocked");
      const quiet = await signup(app, "quiet");
      const open = await signup(app, "open");
      for (const who of [hidden, blocked, quiet, open]) await say(who, `From ${who.user.username} #clay`);
      await hidden.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await zoe.agent.post("/api/users/blocked/block");
      await zoe.agent.put("/api/mutes/people/quiet");
      await follow(zoe, "clay");
      expect((await mine(zoe)).posts.map((p) => p.content)).toEqual(["From open #clay"]);
    });

    it("says nothing when no topic is followed, needs a sign-in, and lets an asked-for tag win", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      await say(kai, "A post #clay");
      await say(kai, "Another #wood");
      expect(await mine(zoe)).toMatchObject({ posts: [], hasMore: false });
      expect((await request(app).get("/api/explore?mine=1")).status).toBe(401);
      await follow(zoe, "clay");
      expect((await mine(zoe, "&tag=wood")).posts.map((p) => p.content)).toEqual(["Another #wood"]);
    });
  });

  describe("the weekly summary setting", () => {
    it("is off to begin with, turns on with the first one a week away, and off again", async () => {
      const zoe = await signup(app, "zoe");
      expect((await zoe.agent.get("/api/digest")).body).toEqual({ enabled: false, emailVerified: false });
      const on = await zoe.agent.put("/api/digest").send({ enabled: true });
      expect(on.body.enabled).toBe(true);
      const row = await M.User.findOne({ username: "zoe" });
      expect(row.weeklyDigest).toBe(true);
      expect(row.digestNextAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86400000);
      expect((await zoe.agent.put("/api/digest").send({ enabled: false })).body.enabled).toBe(false);
      expect((await M.User.findOne({ username: "zoe" })).digestNextAt).toBe(null);
    });

    it("takes only true or false, and only from the person", async () => {
      const zoe = await signup(app, "zoe");
      for (const enabled of ["yes", 1, null, undefined]) expect((await zoe.agent.put("/api/digest").send({ enabled })).status, String(enabled)).toBe(400);
      expect((await request(app).get("/api/digest")).status).toBe(401);
      expect((await request(app).put("/api/digest").send({ enabled: true })).status).toBe(401);
    });
  });

  describe("sending it", () => {
    const digestMails = () => outbox.filter((m) => ["Your week on CreativesSelect", "Tu semana en CreativesSelect", "أسبوعك في CreativesSelect"].includes(m.subject));
    // someone with it on, confirmed, and due
    async function subscriber(name = "zoe", { language = "en" } = {}) {
      const who = await signup(app, name);
      await M.User.updateOne({ _id: who.user.id }, { $set: { emailVerified: true, weeklyDigest: true, digestNextAt: new Date(Date.now() - 1000), digestSinceAt: new Date(Date.now() - 8 * 86400000), language, workOffers: ["vocalist"], openToWork: true } });
      return who;
    }
    const run = (now = new Date(), limit) => digest.runDigests({ now, ...(limit ? { limit } : {}) });

    it("tells what happened as counts and titles, never anyone's words, with a way to stop", async () => {
      const zoe = await subscriber();
      const kai = await signup(app, "kai");
      await kai.agent.post("/api/follows/zoe");
      const post = (await say(zoe, "My post")).body.post;
      await kai.agent.post(`/api/posts/${post.id}/comments`).send({ content: "A secret comment about the thing" });
      await kai.agent.post("/api/calls").send({ title: "A vocalist wanted", details: "Private details of the call", lookingFor: ["vocalist"] });
      await follow(zoe, "clay");
      await say(kai, "Throwing a vase #clay");
      const result = await run();
      expect(result.sent).toBe(1);
      expect(digestMails()).toHaveLength(1);
      const mail = digestMails()[0];
      expect(mail.to).toBe("zoe@example.com");
      expect(mail.subject).toBe("Your week on CreativesSelect");
      expect(mail.text).toContain("New followers: 1");
      expect(mail.text).toContain("Comments, replies and mentions: 1");
      expect(mail.text).toContain("A vocalist wanted");
      expect(mail.text).toContain("#clay: 1");
      expect(mail.text).not.toContain("secret comment");
      expect(mail.text).not.toContain("Private details");
      expect(mail.text).not.toContain("Throwing a vase");
      expect(mail.text).toMatch(/https:\/\/www\.example\.com\/digest\/unsubscribe#token=[\w.-]+/);
      expect(mail.text).toContain("https://www.example.com/explore?mine=1");
    });

    it("writes it in the person's language", async () => {
      const ana = await subscriber("ana", { language: "es" });
      const omar = await subscriber("omar", { language: "ar" });
      const kai = await signup(app, "kai");
      await kai.agent.post("/api/follows/ana");
      await kai.agent.post("/api/follows/omar");
      await run();
      const to = (name) => digestMails().find((m) => m.to === `${name}@example.com`);
      expect(to("ana").subject).toBe("Tu semana en CreativesSelect");
      expect(to("ana").text).toContain("Nuevos seguidores: 1");
      expect(to("omar").subject).toBe("أسبوعك في CreativesSelect");
      expect(to("omar").text).toContain("متابعون جدد: 1");
      expect(ana && omar).toBeTruthy();
    });

    it("sends nothing when there is nothing to say, and looks again in three days", async () => {
      await subscriber();
      const result = await run();
      expect(result).toMatchObject({ sent: 0, looked: 1 });
      expect(digestMails()).toHaveLength(0);
      const row = await M.User.findOne({ username: "zoe" });
      expect(row.digestNextAt.getTime() - Date.now()).toBeGreaterThan(2.9 * 86400000);
      expect(row.digestNextAt.getTime() - Date.now()).toBeLessThan(3.1 * 86400000);
    });

    it("is sent once a week: a second run straight after sends nothing, and the next is a week away", async () => {
      await subscriber();
      const kai = await signup(app, "kai");
      await kai.agent.post("/api/follows/zoe");
      expect((await run()).sent).toBe(1);
      expect((await run()).sent).toBe(0);
      const row = await M.User.findOne({ username: "zoe" });
      expect(row.digestNextAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86400000);
      expect(Date.now() - row.digestSinceAt.getTime()).toBeLessThan(60_000);
      // and a week on, it looks only at what is new since
      outbox.length = 0;
      const later = new Date(Date.now() + 8 * 86400000);
      const liv = await signup(app, "liv");
      await liv.agent.post("/api/follows/zoe");
      await M.Follow.updateOne({ follower: liv.user.id }, { $set: { createdAt: new Date(Date.now() + 86400000) } });
      expect((await run(later)).sent).toBe(1);
      expect(digestMails()[0].text).toContain("New followers: 1");
    });

    it("skips people who haven't turned it on, haven't confirmed their address, are suspended or aren't due", async () => {
      const off = await subscriber("off");
      await M.User.updateOne({ _id: off.user.id }, { $set: { weeklyDigest: false } });
      const unconfirmed = await subscriber("unconfirmed");
      await M.User.updateOne({ _id: unconfirmed.user.id }, { $set: { emailVerified: false } });
      const suspended = await subscriber("suspended");
      await M.User.updateOne({ _id: suspended.user.id }, { $set: { suspendedAt: new Date() } });
      const early = await subscriber("early");
      await M.User.updateOne({ _id: early.user.id }, { $set: { digestNextAt: new Date(Date.now() + 86400000) } });
      const kai = await signup(app, "kai");
      for (const name of ["off", "unconfirmed", "suspended", "early"]) await kai.agent.post(`/api/follows/${name}`);
      expect(await run()).toMatchObject({ sent: 0, looked: 0 });
      expect(digestMails()).toHaveLength(0);
    });

    it("leaves out what came from people they muted or blocked", async () => {
      const zoe = await subscriber();
      const quiet = await signup(app, "quiet");
      const blocked = await signup(app, "blocked");
      await quiet.agent.post("/api/follows/zoe");
      await blocked.agent.post("/api/follows/zoe");
      await zoe.agent.put("/api/mutes/people/quiet");
      await zoe.agent.post("/api/users/blocked/block");
      await blocked.agent.post("/api/follows/zoe"); // refused: blocked
      expect((await run()).sent).toBe(0);
    });

    it("sends at most a few a run, oldest due first", async () => {
      const kai = await signup(app, "kai");
      for (const name of ["anna1", "anna2", "anna3"]) {
        await subscriber(name);
        await kai.agent.post(`/api/follows/${name}`);
      }
      expect((await run(new Date(), 2)).sent).toBe(2);
      expect((await run(new Date(), 2)).sent).toBe(1);
      expect(digestMails().map((m) => m.to).sort()).toEqual(["anna1@example.com", "anna2@example.com", "anna3@example.com"]);
    });

    it("can be run by anyone, but at most once in five minutes", async () => {
      const zoe = await subscriber();
      const kai = await signup(app, "kai");
      await kai.agent.post("/api/follows/zoe");
      const first = await request(app).post("/api/digest/run");
      expect(first.status).toBe(202);
      expect(first.body.sent).toBe(1);
      const again = await request(app).post("/api/digest/run");
      expect(again.status).toBe(202);
      expect(again.body).toEqual({ skipped: true });
      expect(digestMails()).toHaveLength(1);
      expect(zoe).toBeTruthy();
    });
  });

  describe("turning it off from the email", () => {
    it("switches it off with the link's token, without signing in", async () => {
      const zoe = await signup(app, "zoe");
      await zoe.agent.put("/api/digest").send({ enabled: true });
      const token = digest.unsubscribeToken(zoe.user.id);
      const res = await request(app).post("/api/digest/unsubscribe").send({ token });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enabled: false });
      expect((await M.User.findOne({ username: "zoe" })).weeklyDigest).toBe(false);
    });

    it("refuses a token that is forged, for something else, or missing, all the same way", async () => {
      const zoe = await signup(app, "zoe");
      await zoe.agent.put("/api/digest").send({ enabled: true });
      const forged = jwt.sign({ purpose: "digest-off", sub: zoe.user.id }, "another secret");
      const sessionLike = jwt.sign({ sub: zoe.user.id }, process.env.JWT_SECRET);
      const expired = jwt.sign({ purpose: "digest-off", sub: zoe.user.id }, process.env.JWT_SECRET, { expiresIn: -10 });
      for (const token of [forged, sessionLike, expired, "nonsense", "", 5, undefined]) {
        const res = await request(app).post("/api/digest/unsubscribe").send({ token });
        expect(res.status, String(token)).toBe(400);
        expect(res.body.error).toBe("That link isn't valid any more");
      }
      expect((await M.User.findOne({ username: "zoe" })).weeklyDigest).toBe(true);
    });
  });

  describe("tidying up", () => {
    it("forgets topics with the account, and lists them and the setting in the data download", async () => {
      const zoe = await signup(app, "zoe");
      await follow(zoe, "clay");
      await zoe.agent.put("/api/digest").send({ enabled: true });
      const data = JSON.parse((await zoe.agent.post("/api/profiles/me/export").send({ password: "password123" })).text);
      expect(data.followedTopics).toEqual(["clay"]);
      expect(data.weeklySummary).toBe(true);
      expect((await zoe.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await M.TagFollow.countDocuments({})).toBe(0);
    });
  });
});
