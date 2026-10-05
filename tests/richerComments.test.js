import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { Writable } from "stream";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

// A fake Cloudinary: uploads succeed (the size is whatever the test sets), and deletions are recorded.
let nextBytes = 70;
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
            callback(null, { secure_url: `https://res.cloudinary.example/image/upload/v1/creativeselect/comments/pic${counter}.png`, public_id: `creativeselect/comments/pic${counter}`, bytes: nextBytes });
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
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${10 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("richer comments: pictures and links", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      Post: (await import("../models/Post.js")).Post,
      Comment: (await import("../models/Comment.js")).Comment,
      ProfileComment: (await import("../models/ProfileComment.js")).ProfileComment,
      MediaComment: (await import("../models/MediaComment.js")).MediaComment,
      MediaItem: (await import("../models/MediaItem.js")).MediaItem,
      StoredAsset: (await import("../models/StoredAsset.js")).StoredAsset,
      Report: (await import("../models/Report.js")).Report,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    nextBytes = 70;
    counter = 0;
    destroyed.length = 0;
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  // uploads a picture for a comment, through the real route, and returns its address
  const uploadPicture = async (who, type = "image/png") => {
    const res = await who.agent.post("/api/media/upload?purpose=comments").attach("file", PNG, { filename: "pic.png", contentType: type });
    return res;
  };
  const picture = async (who) => (await uploadPicture(who)).body.url;
  const onPost = (who, postId, body) => who.agent.post(`/api/posts/${postId}/comments`).send(body);
  const testimonial = (who, owner, body) => who.agent.post(`/api/profiles/${owner}/comments`).send(body);
  const onPiece = (who, itemId, body) => who.agent.post(`/api/media/${itemId}/comments`).send(body);

  async function setup() {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bobby");
    const post = await M.Post.create({ author: alice.user.id, content: "A post" });
    const piece = await M.MediaItem.create({ owner: alice.user.id, url: "https://images.example.com/p.jpg", type: "image" });
    return { alice, bob, post, piece };
  }

  describe("uploading a picture for a comment", () => {
    it("stores it like any other upload, for the person, and doesn't make a portfolio piece", async () => {
      const { bob } = await setup();
      const res = await uploadPicture(bob);
      expect(res.status).toBe(201);
      expect(res.body.url).toMatch(/pic1\.png$/);
      expect(res.body).not.toHaveProperty("mediaItem");
      expect(await M.MediaItem.countDocuments({ owner: bob.user.id })).toBe(0);
      expect(await M.StoredAsset.findOne({ owner: bob.user.id })).toMatchObject({ kind: "upload", resourceType: "image" });
    });

    it("takes pictures and GIFs, but nothing else", async () => {
      const { bob } = await setup();
      for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) expect((await uploadPicture(bob, type)).status, type).toBe(201);
      for (const type of ["video/mp4", "audio/mpeg", "application/pdf", "image/svg+xml", "text/html"]) expect((await uploadPicture(bob, type)).status, type).toBe(400);
    });

    it("refuses a picture over 5 MB, and removes the stored file", async () => {
      const { bob } = await setup();
      nextBytes = 5 * 1024 * 1024 + 1;
      const res = await uploadPicture(bob);
      expect(res.status).toBe(413);
      expect(res.body.error).toMatch(/5 MB/);
      expect(destroyed).toHaveLength(1);
      expect(await M.StoredAsset.countDocuments()).toBe(0);
    });

    it("limits how many a person can add an hour, and removes the file it refuses", { timeout: 180_000 }, async () => {
      const { bob } = await setup();
      for (let i = 0; i < 20; i++) expect((await uploadPicture(bob)).status, `picture ${i}`).toBe(201);
      const res = await uploadPicture(bob);
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeTruthy();
      expect(destroyed).toHaveLength(1);
      expect(await M.StoredAsset.countDocuments({ owner: bob.user.id })).toBe(20);
    });
  });

  describe("a picture in a comment, on a post, a profile and a portfolio piece", () => {
    it("is shown with the comment, and a picture alone is a comment", async () => {
      const { alice, bob, post, piece } = await setup();
      const a = await picture(bob);
      const onThePost = await onPost(bob, post._id, { content: "Look at this", imageUrl: a });
      expect(onThePost.status).toBe(201);
      expect(onThePost.body.comment).toMatchObject({ content: "Look at this", imageUrl: a });
      const b = await picture(bob);
      const alone = await testimonial(bob, "alice", { imageUrl: b });
      expect(alone.status).toBe(201);
      expect(alone.body.comment).toMatchObject({ content: "", imageUrl: b });
      const c = await picture(bob);
      const onThePiece = await onPiece(bob, piece._id, { content: "", imageUrl: c });
      expect(onThePiece.status).toBe(201);
      expect(onThePiece.body.comment.imageUrl).toBe(c);
      // and everyone who looks sees them
      expect((await alice.agent.get(`/api/posts/${post._id}/comments`)).body.comments[0].imageUrl).toBe(a);
      expect((await alice.agent.get("/api/profiles/alice/comments")).body.comments[0].imageUrl).toBe(b);
      expect((await request(app).get(`/api/media/${piece._id}/comments`)).body.comments[0].imageUrl).toBe(c);
    });

    it("must be a picture the person uploaded here, not any address, someone else's, or a file that isn't a picture", async () => {
      const { alice, bob, post } = await setup();
      const theirs = await picture(alice);
      await M.StoredAsset.create({ owner: bob.user.id, url: "https://res.cloudinary.example/video/upload/clip.mp4", publicId: "clip", resourceType: "video", kind: "upload" });
      await M.StoredAsset.create({ owner: bob.user.id, url: "https://res.cloudinary.example/image/upload/ai.png", publicId: "ai", resourceType: "image", kind: "ai" });
      for (const imageUrl of ["https://evil.example.com/pixel.gif", "http://tracker.example.com/x.png", "javascript:alert(1)", "data:image/png;base64,AAAA", theirs, "https://res.cloudinary.example/video/upload/clip.mp4", "https://res.cloudinary.example/image/upload/ai.png", 5, { a: 1 }, ["x"], ""]) {
        const res = await onPost(bob, post._id, { content: "hi", imageUrl });
        expect(res.status, JSON.stringify(imageUrl)).toBe(400);
      }
      expect(await M.Comment.countDocuments()).toBe(0);
    });

    it("needs words or a picture, and a comment with neither is refused", async () => {
      const { bob, post } = await setup();
      for (const body of [{}, { content: "" }, { content: "   " }, { imageUrl: null }, { content: "", imageUrl: null }]) expect((await onPost(bob, post._id, body)).status, JSON.stringify(body)).toBe(400);
      expect((await onPost(bob, post._id, { content: 5 })).status).toBe(400);
    });

    it("is not given the picture's address by a null, and ignores one the author doesn't send", async () => {
      const { bob, post } = await setup();
      const res = await onPost(bob, post._id, { content: "just words", imageUrl: null });
      expect(res.status).toBe(201);
      expect(res.body.comment.imageUrl).toBeNull();
    });

    it("keeps the author's own text limits, with a picture too", async () => {
      const { bob, post } = await setup();
      const url = await picture(bob);
      expect((await onPost(bob, post._id, { content: "x".repeat(1001), imageUrl: url })).status).toBe(400);
      expect((await onPost(bob, post._id, { content: "x".repeat(1000), imageUrl: url })).status).toBe(201);
    });

    it("can be used in a comment on a private profile's piece only by someone who can see it", async () => {
      const { alice, bob, piece } = await setup();
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      const url = await picture(bob);
      expect((await onPiece(bob, piece._id, { content: "hi", imageUrl: url })).status).toBe(404);
      expect(await M.MediaComment.countDocuments()).toBe(0);
    });
  });

  describe("links in the text", () => {
    it("keeps the words as written, with up to three links", async () => {
      const { bob, post } = await setup();
      const text = "See https://example.com/a and http://example.org/b?x=1 and https://example.net/c.";
      const res = await onPost(bob, post._id, { content: text });
      expect(res.status).toBe(201);
      expect(res.body.comment.content).toBe(text);
    });

    it("refuses more than three links, on every kind of comment", async () => {
      const { bob, post, piece } = await setup();
      const four = "https://a.example.com https://b.example.com https://c.example.com https://d.example.com";
      for (const res of [await onPost(bob, post._id, { content: four }), await testimonial(bob, "alice", { content: four }), await onPiece(bob, piece._id, { content: four })]) {
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/up to 3 links/);
      }
      expect((await onPost(bob, post._id, { content: "https://a.example.com https://b.example.com https://c.example.com" })).status).toBe(201);
    });

    it("counts a link written in a change too", async () => {
      const { bob, post } = await setup();
      const c = (await onPost(bob, post._id, { content: "hello" })).body.comment;
      const four = "https://a.example.com https://b.example.com https://c.example.com https://d.example.com";
      expect((await bob.agent.patch(`/api/comments/${c.id}`).send({ content: four })).status).toBe(400);
    });
  });

  describe("changing a comment that has a picture", () => {
    it("lets the author take the picture off, and the file goes with it", async () => {
      const { alice, bob, post } = await setup();
      const url = await picture(bob);
      const c = (await onPost(bob, post._id, { content: "with a picture", imageUrl: url })).body.comment;
      expect((await alice.agent.patch(`/api/comments/${c.id}`).send({ imageUrl: null })).status).toBe(403);
      const res = await bob.agent.patch(`/api/comments/${c.id}`).send({ imageUrl: null });
      expect(res.status).toBe(200);
      expect(res.body.comment).toMatchObject({ content: "with a picture", imageUrl: null });
      expect(res.body.comment.editedAt).toBeTruthy();
      expect(destroyed).toEqual(["creativeselect/comments/pic1"]);
      expect(await M.StoredAsset.countDocuments({ owner: bob.user.id })).toBe(0);
    });

    it("won't swap one picture for another, or add one later", async () => {
      const { bob, post } = await setup();
      const first = await picture(bob);
      const second = await picture(bob);
      const withPicture = (await onPost(bob, post._id, { content: "a", imageUrl: first })).body.comment;
      const without = (await onPost(bob, post._id, { content: "b" })).body.comment;
      for (const id of [withPicture.id, without.id]) {
        const res = await bob.agent.patch(`/api/comments/${id}`).send({ imageUrl: second });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/new comment/);
      }
      expect((await M.Comment.findById(withPicture.id)).imageUrl).toBe(first);
    });

    it("keeps a comment from ending up with neither words nor a picture", async () => {
      const { bob, post } = await setup();
      const url = await picture(bob);
      const pictureOnly = (await onPost(bob, post._id, { imageUrl: url })).body.comment;
      expect((await bob.agent.patch(`/api/comments/${pictureOnly.id}`).send({ imageUrl: null })).status).toBe(400); // would leave nothing
      expect((await bob.agent.patch(`/api/comments/${pictureOnly.id}`).send({ content: "now with words" })).status).toBe(200);
      expect((await bob.agent.patch(`/api/comments/${pictureOnly.id}`).send({ imageUrl: null })).status).toBe(200);
      expect((await bob.agent.patch(`/api/comments/${pictureOnly.id}`).send({ content: "" })).status).toBe(400);
      expect((await bob.agent.patch(`/api/comments/${pictureOnly.id}`).send({})).status).toBe(400);
    });

    it("works the same for a testimonial and a comment on a piece", async () => {
      const { bob, piece } = await setup();
      const a = await picture(bob);
      const b = await picture(bob);
      const t = (await testimonial(bob, "alice", { content: "great", imageUrl: a })).body.comment;
      const p = (await onPiece(bob, piece._id, { content: "lovely", imageUrl: b })).body.comment;
      expect((await bob.agent.patch(`/api/profiles/comments/${t.id}`).send({ imageUrl: null })).body.comment.imageUrl).toBeNull();
      expect((await bob.agent.patch(`/api/media/comments/${p.id}`).send({ imageUrl: null })).body.comment.imageUrl).toBeNull();
      expect(destroyed.sort()).toEqual(["creativeselect/comments/pic1", "creativeselect/comments/pic2"]);
    });
  });

  describe("when a comment goes away, so does its picture", () => {
    it("is removed when the author or the owner deletes the comment, but kept while another comment still shows it", async () => {
      const { alice, bob, post } = await setup();
      const url = await picture(bob);
      const one = (await onPost(bob, post._id, { content: "first", imageUrl: url })).body.comment;
      const two = (await onPost(bob, post._id, { content: "second", imageUrl: url })).body.comment;
      expect((await bob.agent.delete(`/api/comments/${one.id}`)).status).toBe(204);
      expect(destroyed).toHaveLength(0); // still in the second
      expect((await alice.agent.delete(`/api/comments/${two.id}`)).status).toBe(204); // the post's owner
      expect(destroyed).toEqual(["creativeselect/comments/pic1"]);
    });

    it("is removed with a testimonial or a piece comment that is deleted", async () => {
      const { alice, bob, piece } = await setup();
      const t = (await testimonial(bob, "alice", { imageUrl: await picture(bob) })).body.comment;
      const p = (await onPiece(bob, piece._id, { imageUrl: await picture(bob) })).body.comment;
      expect((await alice.agent.delete(`/api/profiles/comments/${t.id}`)).status).toBe(204);
      expect((await alice.agent.delete(`/api/media/comments/${p.id}`)).status).toBe(204);
      expect(destroyed.sort()).toEqual(["creativeselect/comments/pic1", "creativeselect/comments/pic2"]);
    });

    it("is removed with the post or the piece it was on", async () => {
      const { alice, bob, post, piece } = await setup();
      await onPost(bob, post._id, { imageUrl: await picture(bob) });
      await onPiece(bob, piece._id, { imageUrl: await picture(bob) });
      expect((await alice.agent.delete(`/api/posts/${post._id}`)).status).toBe(204);
      expect((await alice.agent.delete(`/api/media/${piece._id}`)).status).toBe(204);
      expect(destroyed.sort()).toEqual(["creativeselect/comments/pic1", "creativeselect/comments/pic2"]);
      expect(await M.StoredAsset.countDocuments({ owner: bob.user.id })).toBe(0);
    });

    it("is removed when an account goes: its own pictures, and other people's in what went with it", async () => {
      const { alice, bob, post } = await setup();
      await onPost(bob, post._id, { content: "on alice's post", imageUrl: await picture(bob) }); // bob's, in alice's post
      await testimonial(bob, "alice", { imageUrl: await picture(bob) }); // bob's, on alice's profile
      const own = await picture(alice);
      await testimonial(alice, "bobby", { imageUrl: own }); // alice's, on bob's profile
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(destroyed.sort()).toEqual(["creativeselect/comments/pic1", "creativeselect/comments/pic2", "creativeselect/comments/pic3"]);
      expect(await M.StoredAsset.countDocuments()).toBe(0);
    });
  });

  describe("reports and moderators", () => {
    it("shows a moderator the picture and removes it with the comment", async () => {
      const { alice, bob, post } = await setup();
      const url = await picture(bob);
      const c = (await onPost(bob, post._id, { content: "bad", imageUrl: url })).body.comment;
      expect((await alice.agent.post("/api/reports").send({ targetType: "comment", targetId: c.id, reason: "rude picture" })).status).toBe(201);
      const { loadTarget, removeContent } = await import("../services/moderation.js");
      expect((await loadTarget("comment", c.id, alice.user.id)).preview).toMatchObject({ text: "bad", image: url });
      expect(await removeContent("comment", c.id)).toBe(true);
      expect(destroyed).toEqual(["creativeselect/comments/pic1"]);
      expect(await M.Comment.countDocuments()).toBe(0);
    });

    it("does the same for a testimonial and a comment on a piece", async () => {
      const { bob, piece } = await setup();
      const t = (await testimonial(bob, "alice", { imageUrl: await picture(bob) })).body.comment;
      const p = (await onPiece(bob, piece._id, { imageUrl: await picture(bob) })).body.comment;
      const { loadTarget, removeContent } = await import("../services/moderation.js");
      expect((await loadTarget("profileComment", t.id, bob.user.id)).preview.image).toMatch(/pic1/);
      expect((await loadTarget("mediaComment", p.id, bob.user.id)).preview.image).toMatch(/pic2/);
      expect(await removeContent("profileComment", t.id)).toBe(true);
      expect(await removeContent("mediaComment", p.id)).toBe(true);
      expect(destroyed.sort()).toEqual(["creativeselect/comments/pic1", "creativeselect/comments/pic2"]);
    });

    it("removes the pictures of every comment on a post a moderator removes", async () => {
      const { alice, bob, post } = await setup();
      await onPost(bob, post._id, { imageUrl: await picture(bob) });
      const { removeContent } = await import("../services/moderation.js");
      expect(await removeContent("post", post._id)).toBe(true);
      expect(destroyed).toEqual(["creativeselect/comments/pic1"]);
      expect(alice).toBeTruthy();
    });
  });
});
