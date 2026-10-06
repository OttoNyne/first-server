import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { Writable } from "stream";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { MAX_CAPTION, checkCaption } from "../utils/mediaCaption.js";

// A fake Cloudinary, so a photo can be uploaded and its removal seen.
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
            callback(null, { secure_url: `https://res.cloudinary.example/image/upload/v1/creativeselect/portfolio/c${counter}.png`, public_id: `creativeselect/portfolio/c${counter}`, bytes: 70 });
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
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${100 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user, name };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("what a caption can be", () => {
  it("is one tidy line of plain text, or nothing", () => {
    expect(checkCaption("  Sunrise \n over   the  bay  ")).toEqual({ value: "Sunrise over the bay" });
    expect(checkCaption("a\u0000b​c‮d")).toEqual({ value: "a b c d" });
    expect(checkCaption("see https://example.com/x")).toEqual({ value: "see https://example.com/x" });
    for (const nothing of [undefined, null, "", "   ", "\n\t "]) expect(checkCaption(nothing)).toEqual({ value: null });
  });

  it("is at most 200 characters, counted as people see them, and must be text", () => {
    expect(checkCaption("x".repeat(MAX_CAPTION)).value).toHaveLength(MAX_CAPTION);
    expect(checkCaption("x".repeat(MAX_CAPTION + 1)).error).toMatch(/200 characters/);
    expect(checkCaption("😀".repeat(MAX_CAPTION)).error).toBeUndefined();
    expect(checkCaption("😀".repeat(MAX_CAPTION + 1)).error).toBeTruthy();
    for (const bad of [5, true, {}, ["a"]]) expect(checkCaption(bad).error).toMatch(/must be text/);
  });
});

describe("captions on portfolio photos", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      MediaItem: (await import("../models/MediaItem.js")).MediaItem,
      Album: (await import("../models/Album.js")).Album,
      StoredAsset: (await import("../models/StoredAsset.js")).StoredAsset,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    destroyed.length = 0;
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const add = (who, caption, over = {}) => who.agent.post("/api/media").send({ url: "https://images.example.com/a.jpg", type: "image", ...(caption !== undefined ? { caption } : {}), ...over });
  const edit = (who, id, body) => who.agent.patch(`/api/media/${id}`).send(body);
  const upload = (who, caption, purpose = "portfolio") => {
    const req = who.agent.post(`/api/media/upload?purpose=${purpose}`);
    if (caption !== undefined) req.field("caption", caption);
    return req.attach("file", PNG, { filename: "p.png", contentType: "image/png" });
  };
  const listed = async (viewer, username) => (await viewer.agent.get(`/api/media/user/${username}`)).body.media;

  describe("when a piece is added", () => {
    it("keeps the caption, tidied, and none at all is fine", async () => {
      const me = await signup(app, "mimi");
      const a = await add(me, "  Morning \n light  ");
      expect(a.status).toBe(201);
      expect(a.body.mediaItem.caption).toBe("Morning light");
      expect((await add(me)).body.mediaItem.caption).toBeNull();
      expect((await add(me, "   ")).body.mediaItem.caption).toBeNull();
      expect((await add(me, "x".repeat(200))).status).toBe(201);
    });

    it("refuses a caption that is too long or isn't text, and keeps nothing", async () => {
      const me = await signup(app, "mimi");
      expect((await add(me, "x".repeat(201))).status).toBe(400);
      for (const bad of [5, {}, ["a"], true]) expect((await add(me, bad)).status).toBe(400);
      expect(await M.MediaItem.countDocuments()).toBe(0);
    });

    it("takes a caption with an uploaded photo, as a field beside the file", async () => {
      const me = await signup(app, "mimi");
      const res = await upload(me, "  Studio  at dawn ");
      expect(res.status).toBe(201);
      expect(res.body.mediaItem.caption).toBe("Studio at dawn");
      expect((await M.MediaItem.findById(res.body.mediaItem.id)).caption).toBe("Studio at dawn");
      expect((await upload(me)).body.mediaItem.caption).toBeNull();
    });

    it("refuses an uploaded photo's bad caption, takes the file out again and keeps no record of it", async () => {
      const me = await signup(app, "mimi");
      const res = await upload(me, "x".repeat(201));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/200 characters/);
      expect(destroyed).toHaveLength(1);
      expect(await M.MediaItem.countDocuments()).toBe(0);
      expect(await M.StoredAsset.countDocuments()).toBe(0);
    });

    it("ignores a caption sent with a picture meant for somewhere else", async () => {
      const me = await signup(app, "mimi");
      const res = await upload(me, "not for the portfolio", "avatars");
      expect(res.status).toBe(201);
      expect(res.body.mediaItem).toBeUndefined();
      expect(await M.MediaItem.countDocuments()).toBe(0);
    });
  });

  describe("changing a caption afterwards", () => {
    it("lets the owner add one, change it and take it off, and says what is now there", async () => {
      const me = await signup(app, "mimi");
      const id = (await add(me)).body.mediaItem.id;
      const set = await edit(me, id, { caption: "  Harbour  at dusk " });
      expect(set.status).toBe(200);
      expect(set.body.item.caption).toBe("Harbour at dusk");
      expect((await edit(me, id, { caption: "Harbour at night" })).body.item.caption).toBe("Harbour at night");
      expect((await edit(me, id, { caption: null })).body.item.caption).toBeNull();
      await edit(me, id, { caption: "Back again" });
      expect((await edit(me, id, { caption: "   " })).body.item.caption).toBeNull(); // spaces only is none
      expect((await M.MediaItem.findById(id)).caption).toBeNull();
    });

    it("checks it the same way, and leaves the old one when the new one can't be kept", async () => {
      const me = await signup(app, "mimi");
      const id = (await add(me, "Original")).body.mediaItem.id;
      expect((await edit(me, id, { caption: "x".repeat(201) })).status).toBe(400);
      for (const bad of [5, {}, ["a"], false]) expect((await edit(me, id, { caption: bad })).status).toBe(400);
      expect((await M.MediaItem.findById(id)).caption).toBe("Original");
    });

    it("can change the caption and the album together, or either alone, and needs one of them", async () => {
      const me = await signup(app, "mimi");
      const album = (await me.agent.post("/api/albums").send({ title: "Harbour" })).body.album;
      const id = (await add(me, "One")).body.mediaItem.id;
      const both = await edit(me, id, { caption: "Two", album: album.id });
      expect(both.body.item).toMatchObject({ caption: "Two", albumId: album.id });
      expect((await edit(me, id, { caption: "Three" })).body.item).toMatchObject({ caption: "Three", albumId: album.id }); // the album stays
      expect((await edit(me, id, { album: null })).body.item).toMatchObject({ caption: "Three", albumId: null }); // and so does the caption
      const neither = await edit(me, id, {});
      expect(neither.status).toBe(400);
      expect(neither.body.error).toMatch(/caption, or an album/);
      expect((await edit(me, id, { something: "else" })).status).toBe(400);
    });

    it("changes nothing at all when the album part can't be done", async () => {
      const me = await signup(app, "mimi");
      const other = await signup(app, "other");
      const theirs = (await other.agent.post("/api/albums").send({ title: "Not mine" })).body.album;
      const id = (await add(me, "Original")).body.mediaItem.id;
      expect((await edit(me, id, { caption: "Changed", album: theirs.id })).status).toBe(404);
      expect((await M.MediaItem.findById(id)).caption).toBe("Original");
    });

    it("is only for the owner, and for a piece that exists", async () => {
      const me = await signup(app, "mimi");
      const other = await signup(app, "other");
      const id = (await add(me, "Mine")).body.mediaItem.id;
      expect((await edit(other, id, { caption: "Taken over" })).status).toBe(404);
      expect((await request(app).patch(`/api/media/${id}`).send({ caption: "Anonymous" })).status).toBe(401);
      expect((await edit(me, "not-an-id", { caption: "x" })).status).toBe(404);
      expect((await edit(me, "5f1d7f3b8f1d7f3b8f1d7f3b", { caption: "x" })).status).toBe(404);
      expect((await M.MediaItem.findById(id)).caption).toBe("Mine");
    });

    it("changes nothing else about the piece", async () => {
      const me = await signup(app, "mimi");
      const id = (await add(me, "Mine")).body.mediaItem.id;
      await edit(me, id, { caption: "New", url: "https://evil.example/x.jpg", type: "video", isAiImage: true, owner: "5f1d7f3b8f1d7f3b8f1d7f3b", likes: 50 });
      const saved = await M.MediaItem.findById(id);
      expect(saved).toMatchObject({ caption: "New", url: "https://images.example.com/a.jpg", type: "image", isAiImage: false });
      expect(String(saved.owner)).toBe(me.user.id);
    });
  });

  describe("who sees them", () => {
    it("shows a caption to anyone who can see the portfolio, and the new one after a change", async () => {
      const me = await signup(app, "mimi");
      const viewer = await signup(app, "viewer");
      const id = (await add(me, "First")).body.mediaItem.id;
      expect((await listed(viewer, "mimi"))[0].caption).toBe("First");
      await edit(me, id, { caption: "Second" });
      expect((await listed(viewer, "mimi"))[0].caption).toBe("Second");
      await edit(me, id, { caption: null });
      expect((await listed(viewer, "mimi"))[0].caption).toBeNull();
    });

    it("stays as private as the portfolio: a private profile's captions are for friends, and not for anyone blocked", async () => {
      const me = await signup(app, "mimi");
      const stranger = await signup(app, "stranger");
      const friend = await signup(app, "friend");
      const blocked = await signup(app, "blocked");
      await add(me, "Private words");
      await me.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await befriend(me, friend);
      await me.agent.post("/api/users/blocked/block");
      expect((await stranger.agent.get("/api/media/user/mimi")).status).toBe(403);
      expect(JSON.stringify((await stranger.agent.get("/api/media/user/mimi")).body)).not.toContain("Private words");
      expect((await listed(friend, "mimi"))[0].caption).toBe("Private words");
      expect((await blocked.agent.get("/api/media/user/mimi")).status).toBe(403);
    });

    it("is kept as plain text: a web address in a caption is just words", async () => {
      const me = await signup(app, "mimi");
      const res = await add(me, "Prints at <b>https://shop.example/prints</b> now");
      expect(res.body.mediaItem.caption).toBe("Prints at <b>https://shop.example/prints</b> now");
    });
  });
});
