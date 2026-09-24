import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

// No real Cloudinary calls: record what would be destroyed.
const destroy = vi.fn().mockResolvedValue({ result: "ok" });
vi.mock("cloudinary", () => ({
  v2: {
    config: vi.fn(),
    uploader: { destroy: (...args) => destroy(...args), upload: vi.fn(), upload_stream: vi.fn() },
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

describe("deleting a post cleans up its generated image", () => {
  let app;
  let GeneratedImage;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ GeneratedImage } = await import("../models/GeneratedImage.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
    destroy.mockClear();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const URL_A = "https://res.cloudinary.com/demo/image/upload/creativeselect/ai-generated/aaa.jpg";
  const ID_A = "creativeselect/ai-generated/aaa";

  async function postWithImage(agent, url = URL_A) {
    const res = await agent.post("/api/posts").send({ content: "look", imageUrl: url, isAiImage: true });
    return res.body.post.id;
  }

  it("destroys the image and its ledger entry when its only post is deleted", async () => {
    const alice = await signup(app, "alice");
    await GeneratedImage.create({ owner: alice.user.id, url: URL_A, publicId: ID_A });
    const postId = await postWithImage(alice.agent);

    expect((await alice.agent.delete(`/api/posts/${postId}`)).status).toBe(204);

    expect(destroy).toHaveBeenCalledWith(ID_A);
    expect(await GeneratedImage.countDocuments()).toBe(0);
  });

  it("keeps the image while another post still uses it", async () => {
    const alice = await signup(app, "alice");
    await GeneratedImage.create({ owner: alice.user.id, url: URL_A, publicId: ID_A });
    const first = await postWithImage(alice.agent);
    await postWithImage(alice.agent);

    await alice.agent.delete(`/api/posts/${first}`);

    expect(destroy).not.toHaveBeenCalled();
    expect(await GeneratedImage.countDocuments()).toBe(1);
  });

  it("keeps the image while it's someone's profile wallpaper", async () => {
    const alice = await signup(app, "alice");
    await GeneratedImage.create({ owner: alice.user.id, url: URL_A, publicId: ID_A });
    await alice.agent.patch("/api/profiles/me").send({ wallpaperUrl: URL_A });
    const postId = await postWithImage(alice.agent);

    await alice.agent.delete(`/api/posts/${postId}`);

    expect(destroy).not.toHaveBeenCalled();
  });

  it("never deletes an image that someone else generated", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bob");
    // Alice generated it; Bob merely posts the same URL and deletes his post.
    await GeneratedImage.create({ owner: alice.user.id, url: URL_A, publicId: ID_A });
    const bobsPost = await postWithImage(bob.agent);

    await bob.agent.delete(`/api/posts/${bobsPost}`);

    expect(destroy).not.toHaveBeenCalled();
    expect(await GeneratedImage.countDocuments()).toBe(1);
  });

  it("ignores images that were never recorded as generated (uploads, search results)", async () => {
    const alice = await signup(app, "alice");
    const postId = await postWithImage(alice.agent, "https://images.example.com/photo.jpg");

    expect((await alice.agent.delete(`/api/posts/${postId}`)).status).toBe(204);

    expect(destroy).not.toHaveBeenCalled();
  });

  it("still deletes the post if the Cloudinary cleanup fails", async () => {
    const alice = await signup(app, "alice");
    await GeneratedImage.create({ owner: alice.user.id, url: URL_A, publicId: ID_A });
    const postId = await postWithImage(alice.agent);
    destroy.mockRejectedValueOnce(new Error("cloudinary down"));

    expect((await alice.agent.delete(`/api/posts/${postId}`)).status).toBe(204);
    const feed = await alice.agent.get("/api/posts/feed");
    expect(feed.body.posts).toEqual([]);
  });
});
