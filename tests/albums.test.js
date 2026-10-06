import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.107.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  if (extra.private) await agent.patch("/api/profiles/me").send({ isPrivate: true });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("portfolio albums", () => {
  let app, MediaItem, Album;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ MediaItem } = await import("../models/MediaItem.js"));
    ({ Album } = await import("../models/Album.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const makeAlbum = (who, title = "Sketchbook") => who.agent.post("/api/albums").send({ title });
  const piece = (who, n = 1) => MediaItem.create({ owner: who.user.id, url: `https://example.com/p${n}.jpg`, type: "image" });
  const albumsOf = async (viewer, name) => (await viewer.agent.get(`/api/albums/user/${name}`)).body.albums;
  const put = (who, item, album) => who.agent.patch(`/api/media/${item._id}`).send({ album });

  it("needs a sign-in to change anything, but not to look", async () => {
    expect((await request(app).post("/api/albums").send({ title: "x" })).status).toBe(401);
    expect((await request(app).patch("/api/albums/5f1d7f3b8f1d7f3b8f1d7f3b").send({ title: "x" })).status).toBe(401);
    expect((await request(app).delete("/api/albums/5f1d7f3b8f1d7f3b8f1d7f3b")).status).toBe(401);
    expect((await request(app).patch("/api/media/5f1d7f3b8f1d7f3b8f1d7f3b").send({ album: null })).status).toBe(401);
    const alice = await signup(app, "alice");
    await makeAlbum(alice);
    expect((await request(app).get("/api/albums/user/alice")).body.albums).toHaveLength(1);
  });

  describe("making, renaming and deleting", () => {
    it("makes an album with a cleaned-up name, listed oldest first with a count", async () => {
      const alice = await signup(app, "alice");
      const res = await makeAlbum(alice, "  Sketch​book   2026 ");
      expect(res.status).toBe(201);
      expect(res.body.album).toMatchObject({ title: "Sketch book 2026", count: 0 });
      await makeAlbum(alice, "Murals");
      expect((await albumsOf(alice, "alice")).map((a) => a.title)).toEqual(["Sketch book 2026", "Murals"]);
    });

    it("checks the name, refuses a repeat in any case, and allows 12", async () => {
      const alice = await signup(app, "alice");
      for (const title of ["", "   ", null, 5, "x".repeat(61)]) expect((await makeAlbum(alice, title)).status, String(title)).toBe(400);
      await makeAlbum(alice, "Murals");
      expect((await makeAlbum(alice, "MURALS")).status).toBe(409);
      expect((await makeAlbum(alice, "mur.als")).status).toBe(201); // a different name, not a pattern
      const bob = await signup(app, "bobby");
      expect((await makeAlbum(bob, "Murals")).status).toBe(201); // names are per person
      for (let i = 0; i < 10; i++) expect((await makeAlbum(alice, `Album ${i}`)).status).toBe(201);
      expect((await makeAlbum(alice, "One too many")).status).toBe(400);
    });

    it("renames an album, refusing a clash and a bad name, and only for its owner", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const a = (await makeAlbum(alice, "Old")).body.album;
      await makeAlbum(alice, "Taken");
      expect((await alice.agent.patch(`/api/albums/${a.id}`).send({ title: "New" })).body.album.title).toBe("New");
      expect((await alice.agent.patch(`/api/albums/${a.id}`).send({ title: "taken" })).status).toBe(409);
      expect((await alice.agent.patch(`/api/albums/${a.id}`).send({ title: "NEW" })).status).toBe(200); // itself, different case
      expect((await alice.agent.patch(`/api/albums/${a.id}`).send({ title: "" })).status).toBe(400);
      expect((await bob.agent.patch(`/api/albums/${a.id}`).send({ title: "Mine now" })).status).toBe(404);
      expect((await alice.agent.patch("/api/albums/not-an-id").send({ title: "x" })).status).toBe(404);
      expect((await Album.findById(a.id)).title).toBe("NEW");
    });

    it("deletes an album but keeps its pieces, and only for its owner", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const a = (await makeAlbum(alice)).body.album;
      const item = await piece(alice);
      await put(alice, item, a.id);
      expect((await bob.agent.delete(`/api/albums/${a.id}`)).status).toBe(404);
      expect(await Album.countDocuments()).toBe(1);
      expect((await alice.agent.delete(`/api/albums/${a.id}`)).status).toBe(204);
      expect(await Album.countDocuments()).toBe(0);
      expect((await MediaItem.findById(item._id)).album).toBeNull();
      expect(await MediaItem.countDocuments()).toBe(1);
      expect((await alice.agent.delete(`/api/albums/${a.id}`)).status).toBe(404);
      expect((await alice.agent.delete("/api/albums/not-an-id")).status).toBe(404);
    });
  });

  describe("putting pieces in albums", () => {
    it("moves a piece into an album and out again, and the counts follow", async () => {
      const alice = await signup(app, "alice");
      const a = (await makeAlbum(alice)).body.album;
      const one = await piece(alice, 1);
      const two = await piece(alice, 2);
      expect((await put(alice, one, a.id)).body.item.albumId).toBe(a.id);
      await put(alice, two, a.id);
      expect((await albumsOf(alice, "alice"))[0].count).toBe(2);
      expect((await put(alice, one, null)).body.item.albumId).toBeNull();
      expect((await albumsOf(alice, "alice"))[0].count).toBe(1);
    });

    it("shows which album each piece is in on the portfolio list", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const a = (await makeAlbum(alice)).body.album;
      const one = await piece(alice, 1);
      await piece(alice, 2);
      await put(alice, one, a.id);
      const media = (await bob.agent.get("/api/media/user/alice")).body.media;
      expect(media.map((m) => m.albumId).sort((x, y) => String(x).localeCompare(String(y)))).toEqual([a.id, null].sort((x, y) => String(x).localeCompare(String(y))));
    });

    it("refuses someone else's piece, someone else's album, and anything that isn't an album", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const mine = (await makeAlbum(alice)).body.album;
      const theirs = (await makeAlbum(bob, "Bobs")).body.album;
      const item = await piece(alice);
      expect((await put(bob, item, theirs.id)).status).toBe(404); // not bob's piece
      expect((await put(alice, item, theirs.id)).status).toBe(404); // not alice's album
      for (const album of ["not-an-id", 5, {}, [], "5f1d7f3b8f1d7f3b8f1d7f3b"]) expect((await put(alice, item, album)).status, JSON.stringify(album)).toBe(404);
      expect((await alice.agent.patch(`/api/media/${item._id}`).send({})).status).toBe(400);
      expect((await alice.agent.patch("/api/media/not-an-id").send({ album: null })).status).toBe(404);
      expect((await MediaItem.findById(item._id)).album).toBeNull();
      expect((await put(alice, item, mine.id)).status).toBe(200);
    });

    it("can't change anything else about a piece through this", async () => {
      const alice = await signup(app, "alice");
      const a = (await makeAlbum(alice)).body.album;
      const item = await piece(alice);
      await alice.agent.patch(`/api/media/${item._id}`).send({ album: a.id, url: "https://evil.example/x.jpg", owner: "5f1d7f3b8f1d7f3b8f1d7f3b", type: "video", isAiImage: true, likes: 99 });
      const saved = await MediaItem.findById(item._id);
      expect(saved.url).toBe("https://example.com/p1.jpg");
      expect(String(saved.owner)).toBe(alice.user.id);
      expect(saved.type).toBe("image");
      expect(saved.isAiImage).toBe(false);
      expect(saved.caption).toBeNull(); // only a caption (and the album) can be changed, and that is its own, checked, field
    });
  });

  describe("who can see them", () => {
    it("shows albums to anyone who can see the profile, signed in or not", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await makeAlbum(alice, "Public one");
      expect((await albumsOf(bob, "alice")).map((a) => a.title)).toEqual(["Public one"]);
      expect((await request(app).get("/api/albums/user/alice")).body.albums).toHaveLength(1);
    });

    it("hides a private profile's albums from strangers, and shows them to friends", async () => {
      const alice = await signup(app, "alice", { private: true });
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carah");
      await makeAlbum(alice, "Secret");
      await befriend(alice, bob);
      expect((await cara.agent.get("/api/albums/user/alice")).status).toBe(403);
      expect((await request(app).get("/api/albums/user/alice")).status).toBe(403);
      expect((await albumsOf(bob, "alice")).map((a) => a.title)).toEqual(["Secret"]);
    });

    it("hides them between people who have blocked each other, and answers 404 for nobody", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await makeAlbum(alice);
      await bob.agent.post("/api/users/alice/block");
      expect((await bob.agent.get("/api/albums/user/alice")).status).toBe(403);
      expect((await alice.agent.get("/api/albums/user/nobody")).status).toBe(404);
    });
  });

  describe("removal", () => {
    it("takes a piece out of the count when the piece is deleted", async () => {
      const alice = await signup(app, "alice");
      const a = (await makeAlbum(alice)).body.album;
      const item = await piece(alice);
      await put(alice, item, a.id);
      expect((await alice.agent.delete(`/api/media/${item._id}`)).status).toBe(204);
      expect((await albumsOf(alice, "alice"))[0].count).toBe(0);
    });

    it("goes with the account", async () => {
      const alice = await signup(app, "alice");
      await makeAlbum(alice);
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await Album.countDocuments()).toBe(0);
    });
  });
});
