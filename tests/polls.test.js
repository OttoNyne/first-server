import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.119.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("polls in posts", () => {
  let app, Post, PollVote;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Post } = await import("../models/Post.js"));
    ({ PollVote } = await import("../models/PollVote.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const ask = (who, poll, content = "Which one?") => who.agent.post("/api/posts").send({ content, poll });

  describe("asking", () => {
    it("makes a post with a poll: two to four options and a day to answer by default", async () => {
      const zoe = await signup(app, "zoe");
      const res = await ask(zoe, { options: ["Blue", "Green"] });
      expect(res.status).toBe(201);
      const poll = res.body.post.poll;
      expect(poll.options).toEqual([{ text: "Blue", votes: 0 }, { text: "Green", votes: 0 }]);
      expect(poll.total).toBe(0);
      expect(poll.closed).toBe(false);
      expect(poll.myVote).toBe(null);
      const hours = (new Date(poll.endsAt) - Date.now()) / 3600000;
      expect(hours).toBeGreaterThan(23);
      expect(hours).toBeLessThanOrEqual(24);
    });

    it("lets the poll stay open for 1, 3 or 7 days and nothing else", async () => {
      const zoe = await signup(app, "zoe");
      const days = async (d) => (await ask(zoe, { options: ["A", "B"], days: d }));
      const seven = await days(7);
      expect(seven.status).toBe(201);
      expect((new Date(seven.body.post.poll.endsAt) - Date.now()) / 86400000).toBeGreaterThan(6.9);
      expect((await days(3)).status).toBe(201);
      for (const bad of [0, 2, 30, "3", null, 1.5]) expect((await days(bad)).status).toBe(400);
    });

    it("needs two to four different, short, written options", async () => {
      const zoe = await signup(app, "zoe");
      const bad = [
        { options: ["Only one"] },
        { options: ["A", "B", "C", "D", "E"] },
        { options: ["A", ""] },
        { options: ["A", "   "] },
        { options: ["A", "a"] },
        { options: ["A", 5] },
        { options: ["A", "x".repeat(61)] },
        { options: "A, B" },
        { options: [] },
        {},
        [],
        "yes or no",
      ];
      for (const poll of bad) expect((await ask(zoe, poll)).status, JSON.stringify(poll)).toBe(400);
      expect((await ask(zoe, { options: ["A", "B", "C", "D"] })).status).toBe(201);
      expect((await ask(zoe, { options: ["A", "x".repeat(60)] })).status).toBe(201);
    });

    it("cleans the options to one plain line each", async () => {
      const zoe = await signup(app, "zoe");
      const res = await ask(zoe, { options: ["  Red\n  wine ", "<b>Tea</b>"] });
      expect(res.status).toBe(201);
      expect(res.body.post.poll.options[0].text).toBe("Red wine");
    });

    it("keeps a post without a poll as it was", async () => {
      const zoe = await signup(app, "zoe");
      const res = await zoe.agent.post("/api/posts").send({ content: "Just words" });
      expect(res.body.post.poll).toBe(null);
    });
  });

  describe("voting", () => {
    it("counts a vote, tells the voter what they chose, and shows everyone the results", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const post = (await ask(zoe, { options: ["Blue", "Green", "Red"] })).body.post;
      const voted = await kai.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 1 });
      expect(voted.status).toBe(201);
      expect(voted.body.poll.myVote).toBe(1);
      expect(voted.body.poll.total).toBe(1);
      await liv.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 1 });
      await zoe.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 0 });
      const seen = (await kai.agent.get(`/api/posts/${post.id}`)).body.post.poll;
      expect(seen.options.map((o) => o.votes)).toEqual([1, 2, 0]);
      expect(seen.total).toBe(3);
      expect(seen.myVote).toBe(1);
      // each person sees their own choice
      expect((await zoe.agent.get(`/api/posts/${post.id}`)).body.post.poll.myVote).toBe(0);
      // and it is in the feed too
      const inFeed = (await zoe.agent.get("/api/posts/feed")).body.posts.find((p) => p.id === post.id);
      expect(inFeed.poll.total).toBe(3);
    });

    it("makes a vote final: one each, no changing", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const post = (await ask(zoe, { options: ["A", "B"] })).body.post;
      expect((await kai.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 0 })).status).toBe(201);
      const again = await kai.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 1 });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("You have already voted in this poll");
      expect(await PollVote.countDocuments({ post: post.id })).toBe(1);
      expect((await kai.agent.get(`/api/posts/${post.id}`)).body.post.poll.myVote).toBe(0);
    });

    it("refuses an option that isn't there", async () => {
      const zoe = await signup(app, "zoe");
      const post = (await ask(zoe, { options: ["A", "B"] })).body.post;
      for (const option of [2, -1, 1.5, "0", null, undefined]) {
        expect((await zoe.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option })).status, String(option)).toBe(400);
      }
      expect(await PollVote.countDocuments({})).toBe(0);
    });

    it("refuses a vote once the poll has closed, and shows it as closed", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const post = (await ask(zoe, { options: ["A", "B"] })).body.post;
      await kai.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 0 });
      await Post.updateOne({ _id: post.id }, { $set: { "poll.endsAt": new Date(Date.now() - 1000) } });
      const late = await zoe.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 1 });
      expect(late.status).toBe(400);
      expect(late.body.error).toBe("This poll has ended");
      const final = (await zoe.agent.get(`/api/posts/${post.id}`)).body.post.poll;
      expect(final.closed).toBe(true);
      expect(final.options.map((o) => o.votes)).toEqual([1, 0]);
    });

    it("answers 404 for a post without a poll, one that doesn't exist, and a signed-out visitor is refused", async () => {
      const zoe = await signup(app, "zoe");
      const plain = (await zoe.agent.post("/api/posts").send({ content: "No poll here" })).body.post;
      expect((await zoe.agent.put(`/api/posts/${plain.id}/poll/vote`).send({ option: 0 })).status).toBe(404);
      expect((await zoe.agent.put("/api/posts/64b64b64b64b64b64b64b64b/poll/vote").send({ option: 0 })).status).toBe(404);
      expect((await zoe.agent.put("/api/posts/nope/poll/vote").send({ option: 0 })).status).toBe(404);
      const poll = (await ask(zoe, { options: ["A", "B"] })).body.post;
      expect((await request(app).put(`/api/posts/${poll.id}/poll/vote`).send({ option: 0 })).status).toBe(401);
    });

    it("keeps people who can't see the post from voting: a private profile and a block both answer 404", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const post = (await ask(zoe, { options: ["A", "B"] })).body.post;
      await zoe.agent.post("/api/users/liv/block");
      expect((await liv.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 0 })).status).toBe(404);
      await zoe.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await kai.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 0 })).status).toBe(404);
      expect(await PollVote.countDocuments({})).toBe(0);
    });
  });

  describe("everywhere a post is shown", () => {
    it("shows the poll in Explore, the saved list and a profile's pinned post", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const post = (await ask(zoe, { options: ["Yes", "No"] }, "Should I do #poll nights?")).body.post;
      await kai.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 1 });
      const explore = (await kai.agent.get("/api/explore?tag=poll&type=posts")).body.posts[0];
      expect(explore.poll.total).toBe(1);
      expect(explore.poll.myVote).toBe(1);
      await kai.agent.put(`/api/saves/posts/${post.id}`);
      const saved = (await kai.agent.get("/api/saves?type=posts")).body.posts[0];
      expect(saved.poll.myVote).toBe(1);
      await zoe.agent.put(`/api/posts/${post.id}/pin`);
      const pinned = (await kai.agent.get("/api/profiles/zoe")).body.user.pinnedPost;
      expect(pinned.poll.options.map((o) => o.votes)).toEqual([0, 1]);
    });
  });

  describe("tidying up", () => {
    it("takes the votes away with the post", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const post = (await ask(zoe, { options: ["A", "B"] })).body.post;
      await kai.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 0 });
      expect((await zoe.agent.delete(`/api/posts/${post.id}`)).status).toBe(204);
      expect(await PollVote.countDocuments({})).toBe(0);
    });

    it("takes a person's votes away with their account, and the votes on their polls", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const hers = (await ask(zoe, { options: ["A", "B"] })).body.post;
      const his = (await ask(kai, { options: ["A", "B"] })).body.post;
      await kai.agent.put(`/api/posts/${hers.id}/poll/vote`).send({ option: 0 });
      await zoe.agent.put(`/api/posts/${his.id}/poll/vote`).send({ option: 1 });
      expect(await PollVote.countDocuments({})).toBe(2);
      const gone = await kai.agent.delete("/api/profiles/me").send({ password: "password123" });
      expect(gone.status).toBe(204);
      expect(await PollVote.countDocuments({})).toBe(0);
      expect((await zoe.agent.get(`/api/posts/${hers.id}`)).body.post.poll.total).toBe(0);
    });

    it("puts the polls someone asked and their own votes in their data download", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const post = (await ask(zoe, { options: ["Blue", "Green"] })).body.post;
      await kai.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 1 });
      const download = async (who) => JSON.parse((await who.agent.post("/api/profiles/me/export").send({ password: "password123" })).text);
      const asked = await download(zoe);
      expect(asked.posts[0].poll.options).toEqual(["Blue", "Green"]);
      const voter = await download(kai);
      expect(voter.pollVotes).toHaveLength(1);
      expect(voter.pollVotes[0]).toMatchObject({ post: post.id, choice: "Green" });
    });
  });
});
