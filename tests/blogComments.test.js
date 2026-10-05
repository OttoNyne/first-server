import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { Writable } from "stream";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

// A fake Cloudinary, so a picture can be uploaded and its removal seen.
let counter = 0;
const destroyed = [];
vi.mock("cloudinary", () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      destroy: vi.fn(async (publicId) => {
        destroyed.push(publicId);
        return { result: "ok" };
      }),
      upload: vi.fn(),
      upload_stream: (options, callback) =>
        new Writable({
          write(chunk, enc, done) {
            done();
          },
          final(done) {
            counter += 1;
            callback(null, { secure_url: `https://res.cloudinary.example/image/upload/v1/creativeselect/comments/b${counter}.png`, public_id: `creativeselect/comments/b${counter}`, bytes: 70 });
            done();
          },
        }),
    },
  },
}));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${190 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("comments on blog entries", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      BlogEntry: (await import("../models/BlogEntry.js")).BlogEntry,
      BlogComment: (await import("../models/BlogComment.js")).BlogComment,
      Notification: (await import("../models/Notification.js")).Notification,
      StoredAsset: (await import("../models/StoredAsset.js")).StoredAsset,
      Report: (await import("../models/Report.js")).Report,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    counter = 0;
    destroyed.length = 0;
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const entry = async (who, title = "A day in the studio") => (await M.BlogEntry.create({ author: who.user.id, title, body: "Some words." })).id;
  const comment = (who, id, body) => who.agent.post(`/api/blog/${id}/comments`).send(body);
  const listOf = async (who, id, query = "") => (await who.agent.get(`/api/blog/${id}/comments${query}`)).body;
  const notes = async (who) => (await who.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "blog_comment");
  const picture = async (who) => (await who.agent.post("/api/media/upload?purpose=comments").attach("file", PNG, { filename: "p.png", contentType: "image/png" })).body.url;

  describe("writing and reading", () => {
    it("lets anyone signed in comment on an entry they can read, text cleaned, author from the session", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await entry(alice);
      const res = await comment(bob, id, { content: "  Lovely​ writing  ", author: alice.user.id, editedAt: new Date().toISOString() });
      expect(res.status).toBe(201);
      expect(res.body.comment).toMatchObject({ content: "Lovely writing", editedAt: null, imageUrl: null });
      expect(res.body.comment.author.username).toBe("bobby");
      expect((await listOf(alice, id)).comments.map((c) => c.content)).toEqual(["Lovely writing"]);
    });

    it("needs a sign-in for everything, like the blog itself", async () => {
      const alice = await signup(app, "alice");
      const id = await entry(alice);
      expect((await request(app).get(`/api/blog/${id}/comments`)).status).toBe(401);
      expect((await request(app).post(`/api/blog/${id}/comments`).send({ content: "hi" })).status).toBe(401);
      expect((await request(app).patch("/api/blog/comments/5f1d7f3b8f1d7f3b8f1d7f3b").send({ content: "x" })).status).toBe(401);
      expect((await request(app).delete("/api/blog/comments/5f1d7f3b8f1d7f3b8f1d7f3b")).status).toBe(401);
    });

    it("checks the text like every other comment: not empty, not too long, at most three links, text only", async () => {
      const alice = await signup(app, "alice");
      const id = await entry(alice);
      for (const body of [{}, { content: "" }, { content: "   " }, { content: 5 }, { content: { $gt: "" } }, { content: "x".repeat(1001) }, { content: "https://a.example.com https://b.example.com https://c.example.com https://d.example.com" }]) {
        expect((await comment(alice, id, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
      }
      expect((await comment(alice, id, { content: "x".repeat(1000) })).status).toBe(201);
    });

    it("limits how fast someone can comment", { timeout: 180_000 }, async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await entry(alice);
      for (let i = 0; i < 40; i++) expect((await comment(bob, id, { content: `c${i}` })).status).toBe(201);
      const res = await comment(bob, id, { content: "one too many" });
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeTruthy();
    });

    it("answers 404 for an entry that doesn't exist or an id that isn't one", async () => {
      const alice = await signup(app, "alice");
      for (const id of ["5f1d7f3b8f1d7f3b8f1d7f3b", "nope"]) {
        expect((await alice.agent.get(`/api/blog/${id}/comments`)).status, id).toBe(404);
        expect((await comment(alice, id, { content: "hi" })).status, id).toBe(404);
      }
    });
  });

  describe("telling the author", () => {
    it("notifies the author once per comment, with who, which entry and which comment, but not for their own", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await entry(alice, "My studio");
      await comment(alice, id, { content: "note to self" });
      expect(await notes(alice)).toHaveLength(0);
      const made = await comment(bob, id, { content: "Great read" });
      const told = await notes(alice);
      expect(told).toHaveLength(1);
      expect(told[0].actor.username).toBe("bobby");
      expect(told[0].payload).toMatchObject({ entryId: id, commentId: made.body.comment.id, title: "My studio" });
    });
  });

  describe("paging", () => {
    it("shows twenty at a time, oldest first, 'after' asks for the next, and a bad cursor is ignored", async () => {
      const alice = await signup(app, "alice");
      const id = await entry(alice);
      await M.BlogComment.insertMany(Array.from({ length: 25 }, (_, i) => ({ entry: id, author: alice.user.id, content: `c${String(i).padStart(2, "0")}` })));
      const first = await listOf(alice, id);
      expect(first.comments).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.comments[0].content).toBe("c00");
      const second = await listOf(alice, id, `?after=${first.comments[19].id}`);
      expect(second.comments.map((c) => c.content)).toEqual(["c20", "c21", "c22", "c23", "c24"]);
      expect(second.hasMore).toBe(false);
      expect((await listOf(alice, id, "?after=%7B%22%24gt%22%3A1%7D")).comments).toHaveLength(20);
    });

    it("counts them on the entry and on the list of someone's entries", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const first = await entry(alice, "One");
      await entry(alice, "Two");
      await comment(bob, first, { content: "a" });
      await comment(alice, first, { content: "b" });
      expect((await bob.agent.get(`/api/blog/${first}`)).body.entry.commentCount).toBe(2);
      const list = (await bob.agent.get("/api/blog/user/alice")).body.entries;
      expect(Object.fromEntries(list.map((e) => [e.title, e.commentCount]))).toEqual({ One: 2, Two: 0 });
    });
  });

  describe("who can see them", () => {
    it("hides a private profile's entries from strangers (the same 404 as a missing entry) but not from friends", async () => {
      const alice = await signup(app, "alice");
      const friend = await signup(app, "friendly");
      const stranger = await signup(app, "stranger");
      await befriend(alice, friend);
      const id = await entry(alice);
      await comment(alice, id, { content: "private note" });
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await stranger.agent.get(`/api/blog/${id}/comments`)).status).toBe(404);
      expect((await comment(stranger, id, { content: "let me in" })).status).toBe(404);
      expect((await listOf(friend, id)).comments).toHaveLength(1);
      expect((await comment(friend, id, { content: "hello friend" })).status).toBe(201);
    });

    it("hides them both ways when either has blocked the other, and when the author is suspended", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await entry(alice);
      await bob.agent.post(`/api/users/${alice.user.username}/block`);
      expect((await bob.agent.get(`/api/blog/${id}/comments`)).status).toBe(404);
      expect((await comment(bob, id, { content: "hi" })).status).toBe(404);
      await bob.agent.delete(`/api/users/${alice.user.username}/block`);
      await alice.agent.post(`/api/users/${bob.user.username}/block`);
      expect((await comment(bob, id, { content: "hi" })).status).toBe(404);
      await alice.agent.delete(`/api/users/${bob.user.username}/block`);
      await M.User.updateOne({ _id: alice.user.id }, { $set: { suspendedAt: new Date() } });
      expect((await bob.agent.get(`/api/blog/${id}/comments`)).status).toBe(404);
    });

    it("leaves out comments by people you have blocked", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const id = await entry(alice);
      await comment(bob, id, { content: "from bob" });
      await comment(carol, id, { content: "from carol" });
      await alice.agent.post(`/api/users/${bob.user.username}/block`);
      expect((await listOf(alice, id)).comments.map((c) => c.content)).toEqual(["from carol"]);
      expect((await listOf(carol, id)).comments.map((c) => c.content)).toEqual(["from bob", "from carol"]);
    });
  });

  describe("changing and removing", () => {
    it("lets only the author change a comment, marks it, and checks the text again", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await entry(alice);
      const cid = (await comment(bob, id, { content: "Nice wrok" })).body.comment.id;
      expect((await alice.agent.patch(`/api/blog/comments/${cid}`).send({ content: "reworded by the author" })).status).toBe(404);
      expect((await bob.agent.patch(`/api/blog/comments/${cid}`).send({ content: "  " })).status).toBe(400);
      expect((await bob.agent.patch(`/api/blog/comments/${cid}`).send({ content: "x".repeat(1001) })).status).toBe(400);
      expect((await bob.agent.patch(`/api/blog/comments/${cid}`).send({ content: "Nice wrok" })).body.comment.editedAt).toBeNull();
      const res = await bob.agent.patch(`/api/blog/comments/${cid}`).send({ content: "Nice work", author: alice.user.id });
      expect(res.status).toBe(200);
      expect(res.body.comment).toMatchObject({ content: "Nice work" });
      expect(res.body.comment.editedAt).toBeTruthy();
      expect(res.body.comment.author.username).toBe("bobby");
      expect((await bob.agent.patch("/api/blog/comments/nope").send({ content: "x" })).status).toBe(404);
    });

    it("lets the author of the comment or of the entry take it down, and nobody else", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const id = await entry(alice);
      const a = (await comment(bob, id, { content: "bob's" })).body.comment.id;
      const b = (await comment(bob, id, { content: "bob's second" })).body.comment.id;
      expect((await carol.agent.delete(`/api/blog/comments/${a}`)).status).toBe(404);
      expect((await bob.agent.delete(`/api/blog/comments/${a}`)).status).toBe(204);
      expect((await alice.agent.delete(`/api/blog/comments/${b}`)).status).toBe(204);
      expect((await alice.agent.delete(`/api/blog/comments/${b}`)).status).toBe(404);
      expect(await M.BlogComment.countDocuments()).toBe(0);
    });
  });

  describe("pictures in them", () => {
    it("work as in every other comment: a picture alone, taken off, refused for any other address", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await entry(alice);
      const url = await picture(bob);
      const made = await comment(bob, id, { imageUrl: url });
      expect(made.status).toBe(201);
      expect(made.body.comment).toMatchObject({ content: "", imageUrl: url });
      expect((await comment(bob, id, { content: "x", imageUrl: "https://evil.example.com/pixel.gif" })).status).toBe(400);
      expect((await bob.agent.patch(`/api/blog/comments/${made.body.comment.id}`).send({ imageUrl: null })).status).toBe(400); // nothing would be left
      const withWords = (await comment(bob, id, { content: "with words", imageUrl: await picture(bob) })).body.comment;
      const res = await bob.agent.patch(`/api/blog/comments/${withWords.id}`).send({ imageUrl: null });
      expect(res.body.comment).toMatchObject({ content: "with words", imageUrl: null });
      expect(destroyed).toEqual(["creativeselect/comments/b2"]);
    });

    it("are removed with their comment, the entry and the account", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await entry(alice);
      const c = (await comment(bob, id, { imageUrl: await picture(bob) })).body.comment;
      expect((await alice.agent.delete(`/api/blog/comments/${c.id}`)).status).toBe(204);
      expect(destroyed).toEqual(["creativeselect/comments/b1"]);

      // the entry
      const second = (await alice.agent.post("/api/blog").send({ title: "Second", body: "Words." })).body.entry.id;
      await comment(bob, second, { imageUrl: await picture(bob) });
      expect((await alice.agent.delete(`/api/blog/${second}`)).status).toBe(204);
      expect(destroyed).toEqual(["creativeselect/comments/b1", "creativeselect/comments/b2"]);
      expect(await M.BlogComment.countDocuments()).toBe(0);

      // the account: the author's, and other people's pictures in what went with it
      const third = await entry(alice, "Third");
      await comment(bob, third, { imageUrl: await picture(bob) });
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(destroyed.at(-1)).toBe("creativeselect/comments/b3");
      expect(await M.StoredAsset.countDocuments()).toBe(0);
    });
  });

  describe("when things go away", () => {
    it("takes an entry's comments and the notes about them with it", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const made = (await alice.agent.post("/api/blog").send({ title: "Soon gone", body: "Words." })).body.entry.id;
      await comment(bob, made, { content: "hi" });
      expect(await notes(alice)).toHaveLength(1);
      expect((await alice.agent.delete(`/api/blog/${made}`)).status).toBe(204);
      expect(await M.BlogComment.countDocuments()).toBe(0);
      expect(await notes(alice)).toHaveLength(0);
    });

    it("removes the comments by, and on the entries of, an account that is deleted, with the reports about them", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const mine = await entry(alice);
      const bobs = await entry(bob, "Bob's");
      await comment(carol, mine, { content: "on alice's entry" });
      const left = (await comment(alice, bobs, { content: "alice on bob's" })).body.comment.id;
      await comment(carol, bobs, { content: "carol on bob's" });
      await carol.agent.post("/api/reports").send({ targetType: "blogComment", targetId: left, reason: "rude" });
      expect(await M.Report.countDocuments({ targetType: "blogComment" })).toBe(1);
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect((await M.BlogComment.find()).map((c) => c.content)).toEqual(["carol on bob's"]);
      expect(await M.Report.countDocuments({ targetType: "blogComment" })).toBe(0);
    });
  });

  describe("reporting", () => {
    it("lets a comment be reported once it exists, shows the moderator a link to it, and removes it with its picture", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await entry(alice);
      const url = await picture(bob);
      const made = (await comment(bob, id, { content: "rude", imageUrl: url })).body.comment.id;
      expect((await alice.agent.post("/api/reports").send({ targetType: "blogComment", targetId: made, reason: "rude" })).status).toBe(201);
      expect((await alice.agent.post("/api/reports").send({ targetType: "blogComment", targetId: "5f1d7f3b8f1d7f3b8f1d7f3b", reason: "rude" })).status).toBe(404);
      const { loadTarget, removeContent } = await import("../services/moderation.js");
      expect((await loadTarget("blogComment", made, alice.user.id)).preview).toMatchObject({ text: "rude", image: url, link: `/blog/${id}?comment=${made}` });
      expect(await removeContent("blogComment", made)).toBe(true);
      expect(destroyed).toEqual(["creativeselect/comments/b1"]);
    });

    it("removes the comments of an entry a moderator removes", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const id = await entry(alice);
      await comment(bob, id, { imageUrl: await picture(bob) });
      const { removeContent } = await import("../services/moderation.js");
      expect(await removeContent("blogEntry", id)).toBe(true);
      expect(await M.BlogComment.countDocuments()).toBe(0);
      expect(destroyed).toEqual(["creativeselect/comments/b1"]);
    });
  });
});
