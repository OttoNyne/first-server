import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${90 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("comments on portfolio pieces", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      MediaItem: (await import("../models/MediaItem.js")).MediaItem,
      MediaComment: (await import("../models/MediaComment.js")).MediaComment,
      Notification: (await import("../models/Notification.js")).Notification,
      Report: (await import("../models/Report.js")).Report,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const piece = async (owner, url = "https://images.example.com/p.jpg") => (await owner.agent.post("/api/media").send({ type: "image", url })).body.mediaItem.id;
  const comment = (who, id, content) => who.agent.post(`/api/media/${id}/comments`).send({ content });
  const listOf = async (agent, id, query = "") => (await agent.get(`/api/media/${id}/comments${query}`)).body;

  describe("writing and reading", () => {
    it("lets anyone signed in comment on a public piece, with the text cleaned and the author taken from the session", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await piece(alice);
      const res = await bob.agent.post(`/api/media/${id}/comments`).send({ content: "  Love the​ colours  ", author: alice.user.id, editedAt: new Date().toISOString() });
      expect(res.status).toBe(201);
      expect(res.body.comment).toMatchObject({ content: "Love the colours", editedAt: null });
      expect(res.body.comment.author.username).toBe("bobby");
    });

    it("needs a sign-in to write, but not to read a public piece", async () => {
      const alice = await signup(app, "alice");
      const id = await piece(alice);
      await comment(alice, id, "My own note");
      expect((await request(app).post(`/api/media/${id}/comments`).send({ content: "hi" })).status).toBe(401);
      const res = await request(app).get(`/api/media/${id}/comments`);
      expect(res.status).toBe(200);
      expect(res.body.comments.map((c) => c.content)).toEqual(["My own note"]);
    });

    it("refuses empty, over-long and non-text comments, and says nothing was cut", async () => {
      const alice = await signup(app, "alice");
      const id = await piece(alice);
      expect((await comment(alice, id, "   ")).status).toBe(400);
      expect((await comment(alice, id, "x".repeat(1001))).status).toBe(400);
      expect((await comment(alice, id, { $gt: "" })).status).toBe(400);
      expect((await comment(alice, id, "x".repeat(1000))).status).toBe(201);
      expect(await M.MediaComment.countDocuments()).toBe(1);
    });

    it("limits how fast someone can comment", { timeout: 120_000 }, async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await piece(alice);
      for (let i = 0; i < 40; i++) expect((await comment(bob, id, `c${i}`)).status).toBe(201);
      const res = await comment(bob, id, "one too many");
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeTruthy();
    });

    it("answers 404 for a piece that doesn't exist or an id that isn't one", async () => {
      const alice = await signup(app, "alice");
      for (const id of ["5f1d7f3b8f1d7f3b8f1d7f3b", "nope", "undefined"]) {
        expect((await alice.agent.get(`/api/media/${id}/comments`)).status, id).toBe(404);
        expect((await comment(alice, id, "hi")).status, id).toBe(404);
      }
    });
  });

  describe("telling the owner", () => {
    it("notifies the owner once per comment, with who and which piece, but not for their own comments", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await piece(alice);
      await comment(alice, id, "Notes to self");
      expect(await M.Notification.countDocuments({ type: "media_comment" })).toBe(0);
      const made = await comment(bob, id, "Wow");
      const notes = (await alice.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "media_comment");
      expect(notes).toHaveLength(1);
      expect(notes[0].actor.username).toBe("bobby");
      expect(String(notes[0].payload.mediaId)).toBe(id);
      expect(String(notes[0].payload.commentId)).toBe(made.body.comment.id);
    });
  });

  describe("paging", () => {
    it("shows twenty at a time, oldest first, and 'after' asks for the next ones", async () => {
      const alice = await signup(app, "alice");
      const id = await piece(alice);
      await M.MediaComment.insertMany(Array.from({ length: 25 }, (_, i) => ({ item: id, author: alice.user.id, content: `c${String(i).padStart(2, "0")}` })));
      const first = await listOf(alice.agent, id);
      expect(first.comments).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.comments[0].content).toBe("c00");
      const second = await listOf(alice.agent, id, `?after=${first.comments[19].id}`);
      expect(second.comments.map((c) => c.content)).toEqual(["c20", "c21", "c22", "c23", "c24"]);
      expect(second.hasMore).toBe(false);
      expect((await listOf(alice.agent, id, "?after=%7B%22%24gt%22%3A1%7D")).comments).toHaveLength(20); // not an id: ignored
    });

    it("counts them on the portfolio list", async () => {
      const alice = await signup(app, "alice");
      const first = await piece(alice, "https://images.example.com/1.jpg");
      const second = await piece(alice, "https://images.example.com/2.jpg");
      await comment(alice, first, "one");
      await comment(alice, first, "two");
      const media = (await request(app).get(`/api/media/user/alice`)).body.media;
      expect(media.find((m) => m.id === first).commentCount).toBe(2);
      expect(media.find((m) => m.id === second).commentCount).toBe(0);
    });
  });

  describe("who can see them", () => {
    it("hides a private profile's pieces from strangers (the same 404 as a missing piece) but not from friends", async () => {
      const alice = await signup(app, "alice");
      const friend = await signup(app, "friendly");
      const stranger = await signup(app, "stranger");
      await befriend(alice, friend);
      const id = await piece(alice);
      await comment(alice, id, "private note");
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await stranger.agent.get(`/api/media/${id}/comments`)).status).toBe(404);
      expect((await request(app).get(`/api/media/${id}/comments`)).status).toBe(404);
      expect((await comment(stranger, id, "let me in")).status).toBe(404);
      expect((await listOf(friend.agent, id)).comments).toHaveLength(1);
      expect((await comment(friend, id, "hello friend")).status).toBe(201);
    });

    it("hides them both ways when either has blocked the other", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await piece(alice);
      await bob.agent.post(`/api/users/${alice.user.username}/block`);
      expect((await bob.agent.get(`/api/media/${id}/comments`)).status).toBe(404);
      expect((await comment(bob, id, "hi")).status).toBe(404);
      await bob.agent.delete(`/api/users/${alice.user.username}/block`);
      await alice.agent.post(`/api/users/${bob.user.username}/block`);
      expect((await comment(bob, id, "hi")).status).toBe(404);
    });

    it("leaves out comments by people you have blocked", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const id = await piece(alice);
      await comment(bob, id, "from bob");
      await comment(carol, id, "from carol");
      await alice.agent.post(`/api/users/${bob.user.username}/block`);
      expect((await listOf(alice.agent, id)).comments.map((c) => c.content)).toEqual(["from carol"]);
      expect((await listOf(carol.agent, id)).comments.map((c) => c.content)).toEqual(["from bob", "from carol"]);
    });

    it("treats a suspended owner's pieces as not found", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await piece(alice);
      await M.User.updateOne({ _id: alice.user.id }, { $set: { suspendedAt: new Date() } });
      expect((await bob.agent.get(`/api/media/${id}/comments`)).status).toBe(404);
      expect((await comment(bob, id, "hi")).status).toBe(404);
    });
  });

  describe("changing and removing", () => {
    it("lets only the author change a comment, marks it, and checks the text again", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await piece(alice);
      const made = await comment(bob, id, "Nice wrok");
      const cid = made.body.comment.id;
      expect((await alice.agent.patch(`/api/media/comments/${cid}`).send({ content: "reworded by the owner" })).status).toBe(404);
      expect((await request(app).patch(`/api/media/comments/${cid}`).send({ content: "x" })).status).toBe(401);
      expect((await bob.agent.patch(`/api/media/comments/${cid}`).send({ content: "  " })).status).toBe(400);
      expect((await bob.agent.patch(`/api/media/comments/${cid}`).send({ content: "x".repeat(1001) })).status).toBe(400);
      const same = await bob.agent.patch(`/api/media/comments/${cid}`).send({ content: "Nice wrok" });
      expect(same.body.comment.editedAt).toBeNull();
      const res = await bob.agent.patch(`/api/media/comments/${cid}`).send({ content: "Nice work", author: alice.user.id });
      expect(res.status).toBe(200);
      expect(res.body.comment).toMatchObject({ content: "Nice work" });
      expect(res.body.comment.editedAt).toBeTruthy();
      expect(res.body.comment.author.username).toBe("bobby");
      expect((await listOf(alice.agent, id)).comments[0]).toMatchObject({ content: "Nice work" });
      expect((await alice.agent.patch("/api/media/comments/nope").send({ content: "x" })).status).toBe(404);
    });

    it("lets the author or the piece's owner take a comment down, and nobody else", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const id = await piece(alice);
      const a = (await comment(bob, id, "bob's")).body.comment.id;
      const b = (await comment(bob, id, "bob's second")).body.comment.id;
      expect((await carol.agent.delete(`/api/media/comments/${a}`)).status).toBe(404);
      expect((await request(app).delete(`/api/media/comments/${a}`)).status).toBe(401);
      expect((await bob.agent.delete(`/api/media/comments/${a}`)).status).toBe(204);
      expect((await alice.agent.delete(`/api/media/comments/${b}`)).status).toBe(204);
      expect((await alice.agent.delete(`/api/media/comments/${b}`)).status).toBe(404);
      expect(await M.MediaComment.countDocuments()).toBe(0);
    });
  });

  describe("when things go away", () => {
    it("removes a piece's comments with the piece", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await piece(alice);
      await comment(bob, id, "hi");
      expect((await alice.agent.delete(`/api/media/${id}`)).status).toBe(204);
      expect(await M.MediaComment.countDocuments()).toBe(0);
    });

    it("removes the comments on, and by, an account that is deleted, with the reports about them", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const mine = await piece(alice);
      const bobs = await piece(bob);
      await comment(carol, mine, "on alice's piece");
      const left = (await comment(alice, bobs, "alice on bob's piece")).body.comment.id;
      await comment(carol, bobs, "carol on bob's piece");
      await carol.agent.post("/api/reports").send({ targetType: "mediaComment", targetId: left, reason: "rude" });
      expect(await M.Report.countDocuments({ targetType: "mediaComment" })).toBe(1);

      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect((await M.MediaComment.find()).map((c) => c.content)).toEqual(["carol on bob's piece"]);
      expect(await M.Report.countDocuments({ targetType: "mediaComment" })).toBe(0);
    });
  });

  describe("reporting", () => {
    it("lets a comment be reported once it exists, and not before", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await piece(alice);
      const made = (await comment(bob, id, "rude")).body.comment.id;
      expect((await alice.agent.post("/api/reports").send({ targetType: "mediaComment", targetId: made, reason: "rude" })).status).toBe(201);
      expect((await alice.agent.post("/api/reports").send({ targetType: "mediaComment", targetId: "5f1d7f3b8f1d7f3b8f1d7f3b", reason: "rude" })).status).toBe(404);
    });
  });
});
