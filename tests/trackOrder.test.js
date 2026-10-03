import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("a profile's playlist and its order", () => {
  let app;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  // adds YouTube tracks (a real video id is 11 characters) and returns them in order
  async function addTracks(who, titles) {
    const out = [];
    for (const [i, title] of titles.entries()) {
      const res = await who.agent.post("/api/tracks").send({ title, sourceType: "youtube", url: `dQw4w9WgXc${i}` });
      expect(res.status, title).toBe(201);
      out.push(res.body.track);
    }
    return out;
  }
  const listed = async (viewer, username) => (await viewer.agent.get(`/api/profiles/${username}/tracks`)).body.tracks.map((t) => t.title);
  const reorder = (who, ids) => who.agent.put("/api/tracks/order").send({ ids });

  it("lists tracks in the order they were added, with positions 0, 1, 2…", async () => {
    const alice = await signup(app, "alice");
    const tracks = await addTracks(alice, ["One", "Two", "Three"]);
    expect(tracks.map((t) => t.position)).toEqual([0, 1, 2]);
    expect(await listed(alice, "alice")).toEqual(["One", "Two", "Three"]);
  });

  it("puts them in the new order, for the owner and for everyone who looks", async () => {
    const alice = await signup(app, "alice");
    const bobby = await signup(app, "bobby");
    const [one, two, three] = await addTracks(alice, ["One", "Two", "Three"]);

    const res = await reorder(alice, [three.id, one.id, two.id]);
    expect(res.status).toBe(200);
    expect(res.body.tracks.map((t) => t.title)).toEqual(["Three", "One", "Two"]);
    expect(res.body.tracks.map((t) => t.position)).toEqual([0, 1, 2]);
    expect(await listed(alice, "alice")).toEqual(["Three", "One", "Two"]);
    expect(await listed(bobby, "alice")).toEqual(["Three", "One", "Two"]);
  });

  it("keeps the new order when a track is added or removed afterwards", async () => {
    const alice = await signup(app, "alice");
    const [one, two, three] = await addTracks(alice, ["One", "Two", "Three"]);
    await reorder(alice, [two.id, three.id, one.id]);

    await addTracks(alice, ["Four"]);
    expect(await listed(alice, "alice")).toEqual(["Two", "Three", "One", "Four"]);

    expect((await alice.agent.delete(`/api/tracks/${three.id}`)).status).toBe(204);
    const after = (await alice.agent.get("/api/profiles/alice/tracks")).body.tracks;
    expect(after.map((t) => t.title)).toEqual(["Two", "One", "Four"]);
    expect(after.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it("is fine with one track, or none, in the list", async () => {
    const alice = await signup(app, "alice");
    expect((await reorder(alice, [])).body.tracks).toEqual([]);
    const [only] = await addTracks(alice, ["Only"]);
    expect((await reorder(alice, [only.id])).body.tracks.map((t) => t.title)).toEqual(["Only"]);
  });

  it("needs every one of the owner's tracks, once each, and nothing else", async () => {
    const alice = await signup(app, "alice");
    const [one, two, three] = await addTracks(alice, ["One", "Two", "Three"]);
    const stranger = new mongoose.Types.ObjectId().toString();
    for (const ids of [[one.id, two.id], [one.id, two.id, three.id, three.id], [one.id, two.id, two.id], [one.id, two.id, three.id, stranger], [one.id, two.id, stranger], []]) {
      const res = await reorder(alice, ids);
      expect(res.status, JSON.stringify(ids.length)).toBe(400);
      expect(res.body.error).toMatch(/every one of your tracks exactly once/);
    }
    expect(await listed(alice, "alice")).toEqual(["One", "Two", "Three"]); // nothing moved
  });

  it("refuses anything that isn't a list of ids", async () => {
    const alice = await signup(app, "alice");
    await addTracks(alice, ["One"]);
    for (const body of [{}, { ids: "abc" }, { ids: [1] }, { ids: [{ $ne: "" }] }, { ids: null }, { ids: [["x"]] }]) {
      const res = await alice.agent.put("/api/tracks/order").send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("never lets someone put another person's tracks in order, or take part in them", async () => {
    const alice = await signup(app, "alice");
    const mallory = await signup(app, "mallory");
    const [one, two] = await addTracks(alice, ["One", "Two"]);
    await addTracks(mallory, ["Mine"]);
    const res = await reorder(mallory, [two.id, one.id]);
    expect(res.status).toBe(400);
    expect(await listed(alice, "alice")).toEqual(["One", "Two"]);
    // her own order is untouched by Mallory's list, and Mallory's is hers alone
    const mine = (await mallory.agent.get("/api/profiles/mallory/tracks")).body.tracks;
    expect((await reorder(mallory, [mine[0].id])).status).toBe(200);
    expect(await listed(alice, "alice")).toEqual(["One", "Two"]);
  });

  it("needs a sign-in", async () => {
    expect((await request(app).put("/api/tracks/order").send({ ids: [] })).status).toBe(401);
  });

  it("is hidden from strangers along with the rest of a private profile", async () => {
    const alice = await signup(app, "alice");
    const stranger = await signup(app, "stranger");
    const [one, two] = await addTracks(alice, ["One", "Two"]);
    await reorder(alice, [two.id, one.id]);
    await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
    const res = await stranger.agent.get("/api/profiles/alice/tracks");
    expect(res.body.tracks ?? []).toEqual([]);
  });
});
