import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.118.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("a pinned post and a featured piece", () => {
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

  const post = async (who, content) => (await who.agent.post("/api/posts").send({ content })).body.post;
  const piece = async (who, name) => (await who.agent.post("/api/media").send({ type: "image", url: `https://img.example.com/${name}.png` })).body.mediaItem;

  it("pins one of your own posts to your profile, where anyone who can see the profile sees it", async () => {
    const zoe = await signup(app, "zoe");
    const kai = await signup(app, "kai");
    const first = await post(zoe, "My first");
    const second = await post(zoe, "My second");
    expect((await zoe.agent.put(`/api/posts/${first.id}/pin`)).status).toBe(200);
    let profile = (await kai.agent.get("/api/profiles/zoe")).body.user;
    expect(profile.pinnedPost.id).toBe(first.id);
    expect(profile.pinnedPost.content).toBe("My first");
    expect(profile.pinnedPost.pinned).toBe(true);
    // pinning another replaces it: one at a time
    await zoe.agent.put(`/api/posts/${second.id}/pin`);
    profile = (await kai.agent.get("/api/profiles/zoe")).body.user;
    expect(profile.pinnedPost.id).toBe(second.id);
    // the feed says which of your posts is pinned
    const feed = (await zoe.agent.get("/api/posts/feed")).body.posts;
    expect(feed.find((p) => p.id === second.id).pinned).toBe(true);
    expect(feed.find((p) => p.id === first.id).pinned).toBe(false);
    // a visitor who isn't signed in sees it too
    expect((await request(app).get("/api/profiles/zoe")).body.user.pinnedPost.id).toBe(second.id);
  });

  it("only your own posts can be pinned, and anything else is the same not-found", async () => {
    const zoe = await signup(app, "zoe");
    const kai = await signup(app, "kai");
    const hers = await post(zoe, "Hers");
    expect((await kai.agent.put(`/api/posts/${hers.id}/pin`)).status).toBe(404);
    expect((await kai.agent.put("/api/posts/not-an-id/pin")).status).toBe(404);
    expect((await kai.agent.put("/api/posts/64b64b64b64b64b64b64b64b/pin")).status).toBe(404);
    expect((await kai.agent.get("/api/profiles/kai")).body.user.pinnedPost).toBe(null);
    expect((await request(app).put(`/api/posts/${hers.id}/pin`)).status).toBe(401);
  });

  it("unpins, and unpinning a post that isn't pinned changes nothing", async () => {
    const zoe = await signup(app, "zoe");
    const a = await post(zoe, "A");
    const b = await post(zoe, "B");
    await zoe.agent.put(`/api/posts/${a.id}/pin`);
    expect((await zoe.agent.delete(`/api/posts/${b.id}/pin`)).status).toBe(204); // not the pinned one
    expect((await zoe.agent.get("/api/profiles/zoe")).body.user.pinnedPost.id).toBe(a.id);
    expect((await zoe.agent.delete(`/api/posts/${a.id}/pin`)).status).toBe(204);
    expect((await zoe.agent.get("/api/profiles/zoe")).body.user.pinnedPost).toBe(null);
  });

  it("deleting the pinned post leaves nothing pinned", async () => {
    const zoe = await signup(app, "zoe");
    const a = await post(zoe, "A");
    await zoe.agent.put(`/api/posts/${a.id}/pin`);
    expect((await zoe.agent.delete(`/api/posts/${a.id}`)).status).toBe(204);
    expect((await zoe.agent.get("/api/profiles/zoe")).body.user.pinnedPost).toBe(null);
  });

  it("keeps the pinned post of a private profile to the owner and friends", async () => {
    const zoe = await signup(app, "zoe");
    const kai = await signup(app, "kai");
    const a = await post(zoe, "Private words");
    await zoe.agent.put(`/api/posts/${a.id}/pin`);
    await zoe.agent.patch("/api/profiles/me").send({ isPrivate: true });
    const refused = await kai.agent.get("/api/profiles/zoe");
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain("Private words");
    expect((await zoe.agent.get("/api/profiles/zoe")).body.user.pinnedPost.id).toBe(a.id); // the owner still sees it
    const { friendship } = (await kai.agent.post("/api/friends/request/zoe")).body;
    await zoe.agent.post(`/api/friends/accept/${friendship._id}`);
    expect((await kai.agent.get("/api/profiles/zoe")).body.user.pinnedPost.id).toBe(a.id); // and so does a friend
  });

  it("features one of your own pieces, which then comes first in the portfolio", async () => {
    const zoe = await signup(app, "zoe");
    const kai = await signup(app, "kai");
    const one = await piece(zoe, "one");
    const two = await piece(zoe, "two");
    const three = await piece(zoe, "three");
    let list = (await kai.agent.get("/api/media/user/zoe")).body.media;
    expect(list.map((m) => m.id)).toEqual([three.id, two.id, one.id]); // newest first
    expect(list.every((m) => m.featured === false)).toBe(true);
    expect((await zoe.agent.put(`/api/media/${one.id}/feature`)).status).toBe(200);
    list = (await kai.agent.get("/api/media/user/zoe")).body.media;
    expect(list.map((m) => m.id)).toEqual([one.id, three.id, two.id]);
    expect(list[0].featured).toBe(true);
    expect(list.filter((m) => m.featured)).toHaveLength(1);
    // another replaces it
    await zoe.agent.put(`/api/media/${two.id}/feature`);
    list = (await kai.agent.get("/api/media/user/zoe")).body.media;
    expect(list[0].id).toBe(two.id);
    expect(list.filter((m) => m.featured).map((m) => m.id)).toEqual([two.id]);
    // and it can be taken off
    expect((await zoe.agent.delete(`/api/media/${two.id}/feature`)).status).toBe(204);
    list = (await kai.agent.get("/api/media/user/zoe")).body.media;
    expect(list.map((m) => m.id)).toEqual([three.id, two.id, one.id]);
  });

  it("only your own pieces can be featured, and removing the featured piece leaves nothing featured", async () => {
    const zoe = await signup(app, "zoe");
    const kai = await signup(app, "kai");
    const hers = await piece(zoe, "hers");
    expect((await kai.agent.put(`/api/media/${hers.id}/feature`)).status).toBe(404);
    expect((await kai.agent.put("/api/media/nope/feature")).status).toBe(404);
    await zoe.agent.put(`/api/media/${hers.id}/feature`);
    expect((await zoe.agent.delete(`/api/media/${hers.id}`)).status).toBe(204);
    const other = await piece(zoe, "other");
    const list = (await kai.agent.get("/api/media/user/zoe")).body.media;
    expect(list.map((m) => [m.id, m.featured])).toEqual([[other.id, false]]);
  });
});
