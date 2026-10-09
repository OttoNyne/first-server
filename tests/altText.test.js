import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.116.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("descriptions of pictures in posts", () => {
  let app, Post, MAX_ALT;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Post } = await import("../models/Post.js"));
    ({ MAX_ALT } = await import("../routes/posts.routes.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const IMG = "https://img.example.com/a.png";
  const make = (who, over = {}) => who.agent.post("/api/posts").send({ content: "A picture", imageUrl: IMG, ...over });

  it("keeps a description with the picture, cleaned up, and sends it back", async () => {
    const alice = await signup(app, "alice");
    const res = await make(alice, { imageAlt: "  A blue vase​ on a\n wooden table  " });
    expect(res.status).toBe(201);
    expect(res.body.post.imageAlt).toBe("A blue vase on a wooden table");
    expect((await Post.findById(res.body.post.id)).imageAlt).toBe("A blue vase on a wooden table");
  });
  it("is empty when none was given, and ignored on a post with no picture", async () => {
    const alice = await signup(app, "alice");
    expect((await make(alice)).body.post.imageAlt).toBe("");
    const plain = await alice.agent.post("/api/posts").send({ content: "Just words", imageAlt: "ignored" });
    expect(plain.status).toBe(201);
    expect(plain.body.post.imageAlt).toBe("");
  });
  it("refuses one that is too long or isn't text", async () => {
    const alice = await signup(app, "alice");
    const long = await make(alice, { imageAlt: "a".repeat(MAX_ALT + 1) });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe(`A picture description can be up to ${MAX_ALT} characters`);
    for (const bad of [5, {}, ["x"], true]) expect((await make(alice, { imageAlt: bad })).status, JSON.stringify(bad)).toBe(400);
    expect((await make(alice, { imageAlt: "a".repeat(MAX_ALT) })).status).toBe(201);
    expect(await Post.countDocuments()).toBe(1);
  });
  it("can be added or changed later without touching the words or marking the post edited", async () => {
    const alice = await signup(app, "alice");
    const made = (await make(alice)).body.post;
    const res = await alice.agent.patch(`/api/posts/${made.id}`).send({ imageAlt: "A blue vase" });
    expect(res.status).toBe(200);
    expect(res.body.post).toMatchObject({ imageAlt: "A blue vase", content: "A picture", editedAt: null });
    const both = await alice.agent.patch(`/api/posts/${made.id}`).send({ content: "New words", imageAlt: "" });
    expect(both.body.post).toMatchObject({ imageAlt: "", content: "New words" });
    expect(both.body.post.editedAt).not.toBeNull();
    const wordsOnly = await alice.agent.patch(`/api/posts/${made.id}`).send({ content: "Newer words" });
    expect(wordsOnly.body.post.imageAlt).toBe("");
  });
  it("is refused for a post without a picture, from someone else, or as an empty edit", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bobby");
    const withPicture = (await make(alice, { imageAlt: "mine" })).body.post;
    const plain = (await alice.agent.post("/api/posts").send({ content: "words" })).body.post;
    const noPicture = await alice.agent.patch(`/api/posts/${plain.id}`).send({ imageAlt: "x" });
    expect(noPicture.status).toBe(400);
    expect(noPicture.body.error).toBe("That post has no picture");
    expect((await bob.agent.patch(`/api/posts/${withPicture.id}`).send({ imageAlt: "stolen" })).status).toBe(403);
    expect((await alice.agent.patch(`/api/posts/${withPicture.id}`).send({})).status).toBe(400);
    expect((await Post.findById(withPicture.id)).imageAlt).toBe("mine");
  });
  it("shows in a share of the post, in Explore, and in the data download", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bobby");
    const made = (await make(alice, { content: "A vase #clay", imageAlt: "A blue vase" })).body.post;
    const shared = await bob.agent.post(`/api/posts/${made.id}/repost`).send({});
    expect(shared.body.post.repost.imageAlt).toBe("A blue vase");
    expect((await request(app).get("/api/explore?tag=clay")).body.posts[0].imageAlt).toBe("A blue vase");
    const download = JSON.parse((await alice.agent.post("/api/profiles/me/export").send({ password: "password123" })).text);
    expect(download.posts[0].pictureDescription).toBe("A blue vase");
  });
});
