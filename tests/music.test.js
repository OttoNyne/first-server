import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${50 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("music: tracks, plays and the profile song", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      Track: (await import("../models/Track.js")).Track,
      TrackPlay: (await import("../models/TrackPlay.js")).TrackPlay,
      StoredAsset: (await import("../models/StoredAsset.js")).StoredAsset,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  let n = 0;
  const yt = (who, over = {}) => who.agent.post("/api/tracks").send({ title: "A song", sourceType: "youtube", url: `dQw4w9W${String(++n).padStart(4, "0")}`, ...over });
  // a song file the person has uploaded (the upload route records it; here it is recorded directly)
  async function uploaded(who, name = `song${++n}`) {
    const url = `https://res.cloudinary.example/video/upload/${name}.mp3`;
    await M.StoredAsset.create({ owner: who.user.id, url, publicId: `creativesselect/tracks/${name}`, resourceType: "video", kind: "upload" });
    return url;
  }
  const upload = async (who, over = {}) => who.agent.post("/api/tracks").send({ title: "Mine", sourceType: "upload", url: await uploaded(who), ...over });
  const listed = async (viewer, username) => (await viewer.agent.get(`/api/profiles/${username}/tracks`)).body.tracks;

  describe("adding", () => {
    it("adds a track with the title and artist cleaned, and starts with no plays and no profile song", async () => {
      const alice = await signup(app, "alice");
      const res = await yt(alice, { title: "  My​   song ", artist: "  The Band  ", plays: 99, profileSong: true, owner: "x" });
      expect(res.status).toBe(201);
      expect(res.body.track).toMatchObject({ title: "My song", artist: "The Band", sourceType: "youtube", position: 0, plays: 0, profileSong: false, ownerId: alice.user.id });
    });

    it("calls a track with no title 'Untitled track'", async () => {
      const alice = await signup(app, "alice");
      expect((await yt(alice, { title: undefined })).body.track.title).toBe("Untitled track");
      expect((await yt(alice, { title: "   " })).body.track.title).toBe("Untitled track");
    });

    it("checks the text, the kind and the address", async () => {
      const alice = await signup(app, "alice");
      const bad = async (over, pattern) => {
        const res = await yt(alice, over);
        expect(res.status, JSON.stringify(over)).toBe(400);
        expect(res.body.error).toMatch(pattern);
      };
      await bad({ title: "x".repeat(101) }, /100/);
      await bad({ title: { $gt: "" } }, /text/);
      await bad({ artist: "x".repeat(81) }, /80/);
      await bad({ artist: 5 }, /text/);
      await bad({ sourceType: "spotify" }, /upload or youtube/);
      await bad({ sourceType: undefined }, /upload or youtube/);
      await bad({ url: "https://example.com/not-youtube" }, /YouTube/);
      await bad({ url: "" }, /url/);
      await bad({ url: undefined }, /url/);
      await bad({ url: { a: 1 } }, /url/);
      expect(await M.Track.countDocuments()).toBe(0);
    });

    it("takes an uploaded song only if it is a file they uploaded here", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const theirs = await uploaded(bob);
      const picture = "https://res.cloudinary.example/image/upload/pic.png";
      await M.StoredAsset.create({ owner: alice.user.id, url: picture, publicId: "pic", resourceType: "image", kind: "upload" });
      const bad = async (url) => {
        const res = await alice.agent.post("/api/tracks").send({ title: "x", sourceType: "upload", url });
        expect(res.status, url).toBe(400);
        expect(res.body.error).toMatch(/Upload the song first/);
      };
      await bad("https://evil.example.com/song.mp3"); // any address
      await bad(theirs); // someone else's file
      await bad(picture); // their own, but not a song
      expect((await upload(alice)).status).toBe(201);
    });
  });

  describe("how many", () => {
    it("holds twenty tracks, five of them uploaded, and says which limit it hit", { timeout: 180_000 }, async () => {
      const alice = await signup(app, "alice");
      for (let i = 0; i < 5; i++) expect((await upload(alice)).status).toBe(201);
      const sixth = await upload(alice);
      expect(sixth.status).toBe(400);
      expect(sixth.body.error).toMatch(/up to 5 uploaded songs/);
      for (let i = 0; i < 15; i++) expect((await yt(alice)).status, `youtube ${i}`).toBe(201);
      const full = await yt(alice);
      expect(full.status).toBe(400);
      expect(full.body.error).toMatch(/Maximum of 20/);
      expect(await M.Track.countDocuments({ owner: alice.user.id })).toBe(20);
      // taking one away makes room for exactly one more
      const first = (await listed(alice, "alice"))[0];
      expect((await alice.agent.delete(`/api/tracks/${first.id}`)).status).toBe(204);
      expect((await yt(alice)).status).toBe(201);
    });
  });

  describe("changing", () => {
    it("changes the title and artist of your own track, never anyone else's", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const track = (await yt(alice)).body.track;
      expect((await bob.agent.patch(`/api/tracks/${track.id}`).send({ title: "Mine now" })).status).toBe(404);
      expect((await request(app).patch(`/api/tracks/${track.id}`).send({ title: "x" })).status).toBe(401);
      const res = await alice.agent.patch(`/api/tracks/${track.id}`).send({ title: "  New   title ", artist: "Someone", plays: 500, owner: bob.user.id, sourceType: "upload", url: "x", position: 9 });
      expect(res.status).toBe(200);
      expect(res.body.track).toMatchObject({ title: "New title", artist: "Someone", plays: 0, sourceType: "youtube", position: 0, ownerId: alice.user.id });
      const stored = await M.Track.findById(track.id);
      expect(stored.url).toBe(track.url);
      // clearing the artist is allowed, clearing the title is not
      expect((await alice.agent.patch(`/api/tracks/${track.id}`).send({ artist: "" })).body.track.artist).toBe("");
      expect((await alice.agent.patch(`/api/tracks/${track.id}`).send({ title: "  " })).status).toBe(400);
      expect((await alice.agent.patch(`/api/tracks/${track.id}`).send({ title: "x".repeat(101) })).status).toBe(400);
      expect((await alice.agent.patch(`/api/tracks/${track.id}`).send({})).status).toBe(400);
    });

    it("answers 404 for a track that doesn't exist or an id that isn't one", async () => {
      const alice = await signup(app, "alice");
      for (const id of ["5f1d7f3b8f1d7f3b8f1d7f3b", "nope"]) {
        expect((await alice.agent.patch(`/api/tracks/${id}`).send({ title: "x" })).status, id).toBe(404);
        expect((await alice.agent.post(`/api/tracks/${id}/play`)).status, id).toBe(404);
        expect((await alice.agent.delete(`/api/tracks/${id}`)).status, id).toBe(404);
      }
    });
  });

  describe("the profile song", () => {
    it("is one track at a time, set and unset by the owner, and shown to everyone who looks", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const one = (await yt(alice, { title: "One" })).body.track;
      const two = (await yt(alice, { title: "Two" })).body.track;
      expect((await bob.agent.patch(`/api/tracks/${one.id}`).send({ profileSong: true })).status).toBe(404);

      expect((await alice.agent.patch(`/api/tracks/${one.id}`).send({ profileSong: true })).body.track.profileSong).toBe(true);
      expect((await listed(bob, "alice")).map((t) => [t.title, t.profileSong])).toEqual([["One", true], ["Two", false]]);
      // choosing another moves it
      await alice.agent.patch(`/api/tracks/${two.id}`).send({ profileSong: true });
      expect((await listed(bob, "alice")).map((t) => [t.title, t.profileSong])).toEqual([["One", false], ["Two", true]]);
      expect(await M.Track.countDocuments({ owner: alice.user.id, profileSong: true })).toBe(1);
      // stopping
      await alice.agent.patch(`/api/tracks/${two.id}`).send({ profileSong: false });
      expect(await M.Track.countDocuments({ profileSong: true })).toBe(0);
      expect((await alice.agent.patch(`/api/tracks/${two.id}`).send({ profileSong: "yes" })).status).toBe(400);
    });

    it("is separate for each person, and doesn't change the order", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const a = (await yt(alice)).body.track;
      const b = (await yt(bob)).body.track;
      await alice.agent.patch(`/api/tracks/${a.id}`).send({ profileSong: true });
      await bob.agent.patch(`/api/tracks/${b.id}`).send({ profileSong: true });
      expect((await M.Track.find({ profileSong: true })).length).toBe(2);
      await yt(alice);
      expect((await listed(alice, "alice")).map((t) => t.position)).toEqual([0, 1]);
    });

    it("can be changed together with the title in one request", async () => {
      const alice = await signup(app, "alice");
      const t = (await yt(alice)).body.track;
      const res = await alice.agent.patch(`/api/tracks/${t.id}`).send({ title: "Theme", profileSong: true });
      expect(res.body.track).toMatchObject({ title: "Theme", profileSong: true });
    });
  });

  describe("counting plays", () => {
    it("counts a listener once a day per track, not the owner, and says whether it counted", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const track = (await yt(alice)).body.track;

      expect((await alice.agent.post(`/api/tracks/${track.id}/play`)).body).toEqual({ counted: false, plays: 0 }); // your own
      expect((await bob.agent.post(`/api/tracks/${track.id}/play`)).body).toEqual({ counted: true, plays: 1 });
      expect((await bob.agent.post(`/api/tracks/${track.id}/play`)).body).toEqual({ counted: false, plays: 1 }); // again, same day
      expect((await carol.agent.post(`/api/tracks/${track.id}/play`)).body).toEqual({ counted: true, plays: 2 });
      expect((await listed(bob, "alice"))[0].plays).toBe(2);
      expect(await M.TrackPlay.countDocuments()).toBe(2);

      // a day later the same person's play counts again
      await M.TrackPlay.updateOne({ listener: bob.user.id }, { $set: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
      await M.TrackPlay.deleteOne({ listener: bob.user.id }); // what the database's own cleanup does to an old record
      expect((await bob.agent.post(`/api/tracks/${track.id}/play`)).body).toEqual({ counted: true, plays: 3 });
    });

    it("counts concurrent plays by one listener once", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const track = (await yt(alice)).body.track;
      const results = await Promise.all(Array.from({ length: 5 }, () => bob.agent.post(`/api/tracks/${track.id}/play`)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect((await M.Track.findById(track.id)).plays).toBe(1);
    });

    it("needs a sign-in, and only counts for tracks the listener may see", async () => {
      const alice = await signup(app, "alice");
      const friend = await signup(app, "friendly");
      const stranger = await signup(app, "stranger");
      await befriend(alice, friend);
      const track = (await yt(alice)).body.track;
      expect((await request(app).post(`/api/tracks/${track.id}/play`)).status).toBe(401);

      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await stranger.agent.post(`/api/tracks/${track.id}/play`)).status).toBe(404);
      expect((await friend.agent.post(`/api/tracks/${track.id}/play`)).body.counted).toBe(true);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: false });

      await stranger.agent.post(`/api/users/${alice.user.username}/block`);
      expect((await stranger.agent.post(`/api/tracks/${track.id}/play`)).status).toBe(404);
      await stranger.agent.delete(`/api/users/${alice.user.username}/block`);
      await M.User.updateOne({ _id: alice.user.id }, { $set: { suspendedAt: new Date() } });
      expect((await stranger.agent.post(`/api/tracks/${track.id}/play`)).status).toBe(404);
      expect((await M.Track.findById(track.id)).plays).toBe(1);
    });

    it("never shows who listened", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const track = (await yt(alice)).body.track;
      await bob.agent.post(`/api/tracks/${track.id}/play`);
      const shown = JSON.stringify((await listed(alice, "alice"))[0]);
      expect(shown).not.toContain(bob.user.id);
      expect(shown).not.toContain("bobby");
    });
  });

  describe("when things go away", () => {
    it("takes a track's plays with it when it is removed", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const track = (await yt(alice)).body.track;
      await bob.agent.post(`/api/tracks/${track.id}/play`);
      expect((await alice.agent.delete(`/api/tracks/${track.id}`)).status).toBe(204);
      expect(await M.TrackPlay.countDocuments()).toBe(0);
      expect((await bob.agent.delete(`/api/tracks/${track.id}`)).status).toBe(404);
    });

    it("keeps someone else's track from being removed", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const track = (await yt(alice)).body.track;
      expect((await bob.agent.delete(`/api/tracks/${track.id}`)).status).toBe(403);
      expect(await M.Track.countDocuments()).toBe(1);
    });

    it("removes the record of plays made by, and of, an account that is deleted", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const alices = (await yt(alice)).body.track;
      const bobs = (await yt(bob)).body.track;
      await bob.agent.post(`/api/tracks/${alices.id}/play`);
      await carol.agent.post(`/api/tracks/${alices.id}/play`);
      await alice.agent.post(`/api/tracks/${bobs.id}/play`);
      await carol.agent.post(`/api/tracks/${bobs.id}/play`);
      expect(await M.TrackPlay.countDocuments()).toBe(4);

      expect((await bob.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      const left = await M.TrackPlay.find();
      expect(left.map((p) => String(p.listener)).sort()).toEqual([carol.user.id]);
      expect(String(left[0].track)).toBe(alices.id);
      expect(await M.Track.countDocuments({ owner: bob.user.id })).toBe(0);
    });
  });
});
