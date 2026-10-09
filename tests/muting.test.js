import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.120.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("muting people and words", () => {
  let app, Post, Mute, Notification, User;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Post } = await import("../models/Post.js"));
    ({ Mute } = await import("../models/Mute.js"));
    ({ Notification } = await import("../models/Notification.js"));
    ({ User } = await import("../models/User.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const befriend = async (a, b) => {
    const { friendship } = (await a.agent.post(`/api/friends/request/${b.user.username}`)).body;
    await b.agent.post(`/api/friends/accept/${friendship._id}`);
  };
  const say = async (who, content) => (await who.agent.post("/api/posts").send({ content })).body.post;
  const feedOf = async (who) => (await who.agent.get("/api/posts/feed")).body.posts.map((p) => p.content);
  const muteWords = (who, words) => who.agent.put("/api/mutes/words").send({ words });

  describe("people", () => {
    it("mutes someone, lists them, and unmutes", async () => {
      const zoe = await signup(app, "zoe");
      await signup(app, "kai");
      expect((await zoe.agent.put("/api/mutes/people/kai")).status).toBe(201);
      expect((await zoe.agent.put("/api/mutes/people/kai")).status).toBe(200); // twice changes nothing
      expect(await Mute.countDocuments({})).toBe(1);
      const list = (await zoe.agent.get("/api/mutes")).body;
      expect(list.people.map((p) => p.username)).toEqual(["kai"]);
      expect(list.words).toEqual([]);
      expect((await zoe.agent.delete("/api/mutes/people/kai")).status).toBe(204);
      expect((await zoe.agent.delete("/api/mutes/people/kai")).status).toBe(204); // and unmuting twice
      expect((await zoe.agent.get("/api/mutes")).body.people).toEqual([]);
    });

    it("refuses muting yourself or someone who isn't there, and a signed-out visitor", async () => {
      const zoe = await signup(app, "zoe");
      expect((await zoe.agent.put("/api/mutes/people/zoe")).status).toBe(400);
      expect((await zoe.agent.put("/api/mutes/people/nobody")).status).toBe(404);
      expect((await request(app).put("/api/mutes/people/zoe")).status).toBe(401);
      expect((await request(app).get("/api/mutes")).status).toBe(401);
    });

    it("keeps each person's list to themselves", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      await signup(app, "liv");
      await zoe.agent.put("/api/mutes/people/liv");
      await muteWords(zoe, ["secret"]);
      expect((await kai.agent.get("/api/mutes")).body).toEqual({ people: [], words: [] });
    });

    it("stops at 500 people", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const id = (await User.findOne({ username: "zoe" }))._id;
      const others = Array.from({ length: 500 }, () => new User()._id);
      await Mute.insertMany(others.map((muted) => ({ user: id, muted })));
      const refused = await zoe.agent.put("/api/mutes/people/kai");
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/up to 500/);
      expect(kai.user.username).toBe("kai");
    });

    it("takes a muted friend's posts out of the feed, and gives them back when unmuted, with nothing changing for the one muted", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      await befriend(zoe, kai);
      await befriend(zoe, liv);
      await say(kai, "Kai says hi");
      await say(liv, "Liv says hi");
      await say(zoe, "Zoe says hi");
      expect((await feedOf(zoe)).sort()).toEqual(["Kai says hi", "Liv says hi", "Zoe says hi"]);
      const noticesBefore = await Notification.countDocuments({ recipient: (await User.findOne({ username: "kai" }))._id });
      await zoe.agent.put("/api/mutes/people/kai");
      expect((await feedOf(zoe)).sort()).toEqual(["Liv says hi", "Zoe says hi"]);
      // kai still sees zoe, and nobody was told
      expect(await feedOf(kai)).toContain("Zoe says hi");
      expect(await Notification.countDocuments({ recipient: (await User.findOne({ username: "kai" }))._id })).toBe(noticesBefore); // muting told them nothing
      await zoe.agent.delete("/api/mutes/people/kai");
      expect(await feedOf(zoe)).toContain("Kai says hi");
    });

    it("tells their own profile whether you have muted them, to you alone", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      expect((await zoe.agent.get("/api/profiles/kai")).body.user.iMute).toBe(false);
      await zoe.agent.put("/api/mutes/people/kai");
      expect((await zoe.agent.get("/api/profiles/kai")).body.user.iMute).toBe(true);
      expect((await kai.agent.get("/api/profiles/zoe")).body.user.iMute).toBe(false);
      expect((await kai.agent.get("/api/profiles/kai")).body.user.iMute).toBeUndefined(); // your own
      expect((await request(app).get("/api/profiles/kai")).body.user.iMute).toBeUndefined(); // signed out
    });

    it("leaves the muted person's profile and posts reachable", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const post = await say(kai, "Findable");
      await zoe.agent.put("/api/mutes/people/kai");
      expect((await zoe.agent.get("/api/profiles/kai")).status).toBe(200);
      expect((await zoe.agent.get(`/api/posts/${post.id}`)).status).toBe(200);
      expect((await zoe.agent.get("/api/posts/user/kai")).body.posts).toHaveLength(1);
    });

    it("hides a muted person from Explore, and shows everyone else's as before", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      await say(kai, "Kai on #clay");
      await say(liv, "Liv on #clay");
      await kai.agent.post("/api/media").send({ type: "image", url: "https://img.example.com/k.png", caption: "Kai piece #clay" });
      await zoe.agent.put("/api/mutes/people/kai");
      const posts = (await zoe.agent.get("/api/explore?tag=clay")).body.posts.map((p) => p.content);
      expect(posts).toEqual(["Liv on #clay"]);
      expect((await zoe.agent.get("/api/explore?tag=clay&type=pieces")).body.pieces).toEqual([]);
      // someone who muted nobody, and a visitor who is signed out, see both
      expect((await liv.agent.get("/api/explore?tag=clay")).body.posts).toHaveLength(2);
      expect((await request(app).get("/api/explore?tag=clay")).body.posts).toHaveLength(2);
    });

    it("leaves a muted person's notices out of the list, and keeps the others", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const post = await say(zoe, "Zoe's post");
      await kai.agent.post(`/api/posts/${post.id}/comments`).send({ content: "Kai comments" });
      await liv.agent.post(`/api/posts/${post.id}/comments`).send({ content: "Liv comments" });
      expect((await zoe.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "comment")).toHaveLength(2);
      await zoe.agent.put("/api/mutes/people/kai");
      const shown = (await zoe.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "comment");
      expect(shown.map((n) => n.actor.username)).toEqual(["liv"]);
      await zoe.agent.delete("/api/mutes/people/kai");
      expect((await zoe.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "comment")).toHaveLength(2);
    });
  });

  describe("words", () => {
    it("saves the list cleaned: one line each, lower case, no repeats, empty ones dropped", async () => {
      const zoe = await signup(app, "zoe");
      const res = await muteWords(zoe, ["  Spoilers ", "spoilers", "", "  ", "Very\n  Loud", "#Politics"]);
      expect(res.status).toBe(200);
      expect(res.body.words).toEqual(["spoilers", "very loud", "#politics"]);
      expect((await zoe.agent.get("/api/mutes")).body.words).toEqual(["spoilers", "very loud", "#politics"]);
      expect((await muteWords(zoe, [])).body.words).toEqual([]);
    });

    it("refuses a list that is too long, a word that is, and anything that isn't a list of text", async () => {
      const zoe = await signup(app, "zoe");
      expect((await muteWords(zoe, Array.from({ length: 31 }, (_, i) => `word${i}`))).status).toBe(400);
      expect((await muteWords(zoe, Array.from({ length: 30 }, (_, i) => `word${i}`))).status).toBe(200);
      expect((await muteWords(zoe, ["x".repeat(41)])).status).toBe(400);
      expect((await muteWords(zoe, ["x".repeat(40)])).status).toBe(200);
      for (const bad of ["spoilers", { a: 1 }, [5], [null], undefined]) expect((await muteWords(zoe, bad)).status, JSON.stringify(bad)).toBe(400);
      expect((await request(app).put("/api/mutes/words").send({ words: ["a"] })).status).toBe(401);
    });

    it("hides posts with a muted word as a whole word in any capitals, and nothing else", async () => {
      const zoe = await signup(app, "zoe");
      await muteWords(zoe, ["art"]);
      await say(zoe, "My ART today");
      await say(zoe, "A fresh start");
      await say(zoe, "Smart choices");
      await say(zoe, "Pop-art, again");
      await say(zoe, "Painting with art.");
      expect((await feedOf(zoe)).sort()).toEqual(["A fresh start", "Smart choices"]);
    });

    it("hides phrases and hashtags as they are written", async () => {
      const zoe = await signup(app, "zoe");
      await muteWords(zoe, ["season finale", "#spoilers"]);
      await say(zoe, "The Season Finale was something");
      await say(zoe, "The season was a finale of sorts");
      await say(zoe, "No words, just #spoilers");
      await say(zoe, "A #spoilersfree zone");
      expect((await feedOf(zoe)).sort()).toEqual(["A #spoilersfree zone", "The season was a finale of sorts"]);
    });

    it("works for words in other alphabets", async () => {
      const zoe = await signup(app, "zoe");
      await muteWords(zoe, ["السياسة"]);
      await say(zoe, "نقاش عن السياسة اليوم");
      await say(zoe, "نقاش عن الفن");
      expect(await feedOf(zoe)).toEqual(["نقاش عن الفن"]);
    });

    it("also hides a post whose poll or shared post has the word", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      await muteWords(zoe, ["pineapple"]);
      await zoe.agent.post("/api/follows/kai");
      await kai.agent.post("/api/posts").send({ content: "Pizza night?", poll: { options: ["Pineapple", "Plain"] } });
      const original = await say(kai, "I love pineapple pizza");
      await kai.agent.post("/api/posts").send({ content: "Plain words" });
      const sharer = await signup(app, "liv");
      await zoe.agent.post("/api/follows/liv");
      await sharer.agent.post(`/api/posts/${original.id}/repost`).send({ content: "" });
      expect(await feedOf(zoe)).toEqual(["Plain words"]);
    });

    it("still fills a page when many of the newest posts are hidden, and says when there is no more", async () => {
      const zoe = await signup(app, "zoe");
      await muteWords(zoe, ["hidden"]);
      const id = (await User.findOne({ username: "zoe" }))._id;
      const docs = [];
      for (let i = 0; i < 5; i++) docs.push({ author: id, content: `shown ${i}` });
      for (let i = 0; i < 150; i++) docs.push({ author: id, content: `hidden ${i}` });
      await Post.insertMany(docs);
      const first = (await zoe.agent.get("/api/posts/feed")).body;
      expect(first.posts.map((p) => p.content)).toEqual(["shown 4", "shown 3", "shown 2", "shown 1", "shown 0"]);
      expect(first.hasMore).toBe(false);
    });

    it("hides posts and pieces with the word from Explore", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      await muteWords(zoe, ["raku"]);
      await say(kai, "Raku firing #clay");
      await say(kai, "Slip casting #clay");
      await kai.agent.post("/api/media").send({ type: "image", url: "https://img.example.com/a.png", caption: "A raku bowl #clay" });
      await kai.agent.post("/api/media").send({ type: "image", url: "https://img.example.com/b.png", caption: "A jug #clay" });
      expect((await zoe.agent.get("/api/explore?tag=clay")).body.posts.map((p) => p.content)).toEqual(["Slip casting #clay"]);
      expect((await zoe.agent.get("/api/explore?tag=clay&type=pieces")).body.pieces.map((p) => p.item.caption)).toEqual(["A jug #clay"]);
      expect((await kai.agent.get("/api/explore?tag=clay")).body.posts).toHaveLength(2);
    });

    it("does not hide a saved post, a post opened directly, or someone's profile", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const post = await say(kai, "Raku firing");
      await zoe.agent.put(`/api/saves/posts/${post.id}`);
      await muteWords(zoe, ["raku"]);
      expect((await zoe.agent.get("/api/saves?type=posts")).body.posts).toHaveLength(1);
      expect((await zoe.agent.get(`/api/posts/${post.id}`)).status).toBe(200);
    });
  });

  describe("tidying up", () => {
    it("forgets a person's mutes with their account, and mutes of them", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      await zoe.agent.put("/api/mutes/people/kai");
      await liv.agent.put("/api/mutes/people/kai");
      await kai.agent.put("/api/mutes/people/zoe");
      expect(await Mute.countDocuments({})).toBe(3);
      expect((await kai.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await Mute.countDocuments({})).toBe(0);
      expect((await zoe.agent.get("/api/mutes")).body.people).toEqual([]);
    });

    it("puts the muted people and words in the data download", async () => {
      const zoe = await signup(app, "zoe");
      await signup(app, "kai");
      await zoe.agent.put("/api/mutes/people/kai");
      await muteWords(zoe, ["spoilers"]);
      const data = JSON.parse((await zoe.agent.post("/api/profiles/me/export").send({ password: "password123" })).text);
      expect(data.muted).toEqual({ people: ["kai"], words: ["spoilers"] });
    });

    it("does not show muted words on anyone else's profile or in the account data a page loads", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      await muteWords(zoe, ["secret-word"]);
      expect(JSON.stringify((await kai.agent.get("/api/profiles/zoe")).body)).not.toContain("secret-word");
      expect(JSON.stringify((await zoe.agent.get("/api/auth/me")).body)).not.toContain("secret-word");
    });
  });
});
