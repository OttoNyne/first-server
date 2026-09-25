import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { Writable } from "stream";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

const destroy = vi.fn().mockResolvedValue({ result: "ok" });
let nextResult;
vi.mock("cloudinary", () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      destroy: (...args) => destroy(...args),
      upload: vi.fn(),
      upload_stream: (options, callback) =>
        new Writable({
          write(chunk, enc, done) {
            done();
          },
          final(done) {
            const { error, result } = nextResult();
            callback(error, result);
            done();
          },
        }),
    },
  },
}));

async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({
    email: `${name}@example.com`,
    username: name,
    password: "password123",
    displayName: name,
  });
  return { agent, user: res.body.user };
}

const BYTES = Buffer.from("not-really-a-video");

describe("portfolio reactions and videos", () => {
  let app;
  let m;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    m = {
      MediaItem: (await import("../models/MediaItem.js")).MediaItem,
      MediaReaction: (await import("../models/MediaReaction.js")).MediaReaction,
      StoredAsset: (await import("../models/StoredAsset.js")).StoredAsset,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    destroy.mockClear();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  async function addPicture(owner) {
    const res = await owner.agent.post("/api/media").send({ url: "https://images.example.com/p.jpg", type: "image" });
    return res.body.mediaItem.id;
  }
  const react = (agent, id, value) => agent.put(`/api/media/${id}/reaction`).send({ value });
  const listAs = async (agent, username) => (await agent.get(`/api/media/user/${username}`)).body.media;

  describe("likes and dislikes", () => {
    it("lets people like, switch to dislike, and clear — one reaction each", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const id = await addPicture(alice);

      let res = await react(bobby.agent, id, 1);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ likes: 1, dislikes: 0, myReaction: 1 });

      res = await react(bobby.agent, id, 1); // liking twice doesn't double count
      expect(res.body).toEqual({ likes: 1, dislikes: 0, myReaction: 1 });

      res = await react(bobby.agent, id, -1); // switch
      expect(res.body).toEqual({ likes: 0, dislikes: 1, myReaction: -1 });

      res = await react(bobby.agent, id, 0); // clear
      expect(res.body).toEqual({ likes: 0, dislikes: 0, myReaction: 0 });
      expect(await m.MediaReaction.countDocuments()).toBe(0);
    });

    it("counts everyone's reactions, and shows each viewer only their own", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const id = await addPicture(alice);
      await react(bobby.agent, id, 1);
      await react(carol.agent, id, -1);
      await react(alice.agent, id, 1); // owners can like their own work

      const asBobby = (await listAs(bobby.agent, "alice"))[0];
      expect(asBobby).toMatchObject({ likes: 2, dislikes: 1, myReaction: 1 });
      const asCarol = (await listAs(carol.agent, "alice"))[0];
      expect(asCarol).toMatchObject({ likes: 2, dislikes: 1, myReaction: -1 });
      const signedOut = (await listAs(request(app), "alice"))[0];
      expect(signedOut).toMatchObject({ likes: 2, dislikes: 1, myReaction: 0 });
    });

    it("rejects invalid values, unknown items, malformed ids, and signed-out reactions", async () => {
      const alice = await signup(app, "alice");
      const id = await addPicture(alice);
      for (const bad of [2, "1", null, true, undefined]) {
        expect((await react(alice.agent, id, bad)).status).toBe(400);
      }
      expect((await react(alice.agent, "64b0f0f0f0f0f0f0f0f0f0f0", 1)).status).toBe(404);
      expect((await react(alice.agent, "not-an-id", 1)).status).toBe(400);
      expect((await request(app).put(`/api/media/${id}/reaction`).send({ value: 1 })).status).toBe(401);
    });

    it("respects private profiles and blocks", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const id = await addPicture(alice);

      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await react(bobby.agent, id, 1)).status).toBe(404); // a stranger can't even tell it exists
      const { friendship } = (await bobby.agent.post("/api/friends/request/alice")).body;
      await alice.agent.post(`/api/friends/accept/${friendship._id}`);
      expect((await react(bobby.agent, id, 1)).status).toBe(200); // a friend can

      await alice.agent.patch("/api/profiles/me").send({ isPrivate: false });
      await alice.agent.post("/api/users/carol/block");
      expect((await react(carol.agent, id, 1)).status).toBe(404);
    });

    it("removes reactions when the picture is deleted", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const id = await addPicture(alice);
      await react(bobby.agent, id, 1);

      expect((await alice.agent.delete(`/api/media/${id}`)).status).toBe(204);
      expect(await m.MediaReaction.countDocuments()).toBe(0);
    });

    it("removes reactions on and by a user when their account is deleted", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const aliceItem = await addPicture(alice);
      const bobbyItem = await addPicture(bobby);
      await react(bobby.agent, aliceItem, 1);
      await react(alice.agent, bobbyItem, -1);

      await alice.agent.delete("/api/profiles/me").send({ password: "password123" });

      expect(await m.MediaReaction.countDocuments()).toBe(0);
      expect((await listAs(bobby.agent, "bobby"))[0]).toMatchObject({ likes: 0, dislikes: 0 });
    });
  });

  describe("video uploads (30 seconds max)", () => {
    let agent;
    let userId;
    beforeEach(async () => {
      const u = await signup(app, "vidmaker");
      agent = u.agent;
      userId = u.user.id;
    });
    const sendVideo = (purpose = "portfolio", type = "video/mp4", name = "clip.mp4") =>
      agent.post(`/api/media/upload?purpose=${purpose}`).attach("file", BYTES, { filename: name, contentType: type });
    const cloudinaryResult = (duration, id = "creativeselect/portfolio/clip1") => () => ({
      result: { secure_url: `https://res.cloudinary.com/demo/video/upload/v1/${id}.mp4`, public_id: id, bytes: 100, duration, resource_type: "video" },
    });

    it("accepts a video of 30 seconds or less and records it as the user's upload", async () => {
      nextResult = cloudinaryResult(12.4);
      const res = await sendVideo();
      expect(res.status).toBe(201);
      expect(res.body.mediaItem).toMatchObject({ type: "video", durationSeconds: 12.4 });
      expect(await m.StoredAsset.findOne({ owner: userId })).toMatchObject({ kind: "upload", resourceType: "video" });
    });

    it("accepts exactly 30 seconds, and phone-style QuickTime files", async () => {
      nextResult = cloudinaryResult(30);
      expect((await sendVideo()).status).toBe(201);
      nextResult = cloudinaryResult(30.4, "creativeselect/portfolio/clip2");
      expect((await sendVideo("portfolio", "video/quicktime", "IMG_0001.MOV")).status).toBe(201);
    });

    it("rejects a longer video, removes the stored file, and creates nothing", async () => {
      nextResult = cloudinaryResult(42.7);
      const res = await sendVideo();
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/30 seconds.*43 seconds/);
      expect(destroy).toHaveBeenCalledWith("creativeselect/portfolio/clip1", { resource_type: "video", invalidate: true });
      expect(await m.MediaItem.countDocuments()).toBe(0);
      expect(await m.StoredAsset.countDocuments()).toBe(0);
    });

    it("rejects a video whose length can't be determined", async () => {
      nextResult = cloudinaryResult(undefined);
      const res = await sendVideo();
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/length/i);
      expect(destroy).toHaveBeenCalled();
      expect(await m.MediaItem.countDocuments()).toBe(0);
    });

    it("doesn't accept video where only images are allowed", async () => {
      nextResult = cloudinaryResult(5);
      expect((await sendVideo("avatars")).status).toBe(400);
      expect(await m.MediaItem.countDocuments()).toBe(0);
    });

    it("deleting the video removes the file from storage", async () => {
      nextResult = cloudinaryResult(8);
      const id = (await sendVideo()).body.mediaItem.id;
      expect((await agent.delete(`/api/media/${id}`)).status).toBe(204);
      expect(destroy).toHaveBeenCalledWith("creativeselect/portfolio/clip1", { resource_type: "video", invalidate: true });
    });
  });

  describe("video links", () => {
    let agent;
    beforeEach(async () => {
      agent = (await signup(app, "linker")).agent;
    });
    const addLink = (url, extra = {}) => agent.post("/api/media").send({ type: "video", url, ...extra });

    it("turns any YouTube link form into a canonical embed, with an optional start time", async () => {
      const forms = [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ?t=5",
        "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
        "https://www.youtube.com/shorts/dQw4w9WgXcQ",
        "https://www.youtube.com/embed/dQw4w9WgXcQ",
      ];
      for (const link of forms) {
        const res = await addLink(link, { startSeconds: 42 });
        expect(res.status).toBe(201);
        expect(res.body.mediaItem).toMatchObject({
          type: "embed",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          startSeconds: 42,
        });
      }
    });

    it("accepts a direct https video file link and drops any #fragment", async () => {
      const res = await addLink("https://cdn.example.com/clips/demo.mp4?token=abc#t=99");
      expect(res.status).toBe(201);
      expect(res.body.mediaItem).toMatchObject({ type: "video", url: "https://cdn.example.com/clips/demo.mp4?token=abc" });
      expect(res.body.mediaItem.startSeconds).toBe(0);
      for (const ext of ["webm", "mov", "m4v"]) {
        expect((await addLink(`https://cdn.example.com/a.${ext}`)).status).toBe(201);
      }
    });

    it("rejects anything that isn't a safe video link", async () => {
      const bad = [
        "http://www.youtube.com/watch?v=dQw4w9WgXcQ", // not https
        "javascript:alert(1)",
        "not a url",
        "",
        "https://www.youtube.com/watch", // no video id
        "https://www.youtube.com/watch?v=short",
        "https://evil.example.net/?u=youtube.com/watch?v=dQw4w9WgXcQ", // id smuggled into another site
        "https://evil.example.net/page.html",
        "https://cdn.example.com/file.exe",
        "https://vimeo.com/123456",
        `https://cdn.example.com/${"a".repeat(2100)}.mp4`,
      ];
      for (const link of bad) expect((await addLink(link)).status).toBe(400);
      expect((await addLink(undefined)).status).toBe(400);
      expect((await addLink({ evil: true })).status).toBe(400);
    });

    it("validates the start time", async () => {
      const link = "https://youtu.be/dQw4w9WgXcQ";
      for (const bad of [-1, 1.5, "abc", 50000]) expect((await addLink(link, { startSeconds: bad })).status).toBe(400);
      expect((await addLink(link, { startSeconds: 0 })).status).toBe(201);
      expect((await addLink(link, { startSeconds: "17" })).status).toBe(201);
    });

    it("still only accepts https images (or inline AI images), and validates captions", async () => {
      const post = (body) => agent.post("/api/media").send(body);
      expect((await post({ type: "image", url: "http://images.example.com/a.jpg" })).status).toBe(400);
      expect((await post({ type: "image", url: "javascript:alert(1)" })).status).toBe(400);
      expect((await post({ type: "image", url: "https://images.example.com/a.jpg", caption: "x".repeat(201) })).status).toBe(400);
      expect((await post({ type: "image", url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", isAiImage: true })).status).toBe(201);
      expect((await post({ type: "audio", url: "https://x.example.com/a.mp3" })).status).toBe(400);
    });

    it("lists video items with their start time", async () => {
      await addLink("https://youtu.be/dQw4w9WgXcQ", { startSeconds: 7 });
      const list = (await agent.get("/api/media/user/linker")).body.media;
      expect(list[0]).toMatchObject({ type: "embed", startSeconds: 7, likes: 0, dislikes: 0, myReaction: 0 });
    });
  });
});
