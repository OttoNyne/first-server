import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

describe("how a post's picture is framed", () => {
  let app;
  let agent;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
    agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email: "a@example.com", username: "alice", password: "password123", displayName: "Alice" });
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const post = (body) => agent.post("/api/posts").send({ content: "look", imageUrl: "https://res.cloudinary.com/demo/image/upload/x.jpg", ...body });

  it("saves the shape, zoom and position and returns them in the post and the feed", async () => {
    const res = await post({ imageAspect: "16:9", imageZoom: 1.75, imagePosition: "20% 80%" });
    expect(res.status).toBe(201);
    expect(res.body.post).toMatchObject({ imageAspect: "16:9", imageZoom: 1.75, imagePosition: "20% 80%" });
    const feed = (await agent.get("/api/posts/feed")).body.posts;
    expect(feed[0]).toMatchObject({ imageAspect: "16:9", imageZoom: 1.75, imagePosition: "20% 80%" });
    const profile = (await agent.get("/api/posts/user/alice")).body.posts;
    expect(profile[0].imageZoom).toBe(1.75);
  });

  it("leaves the framing empty on older-style posts (no framing sent) so they look as they always did", async () => {
    const res = await post({});
    expect(res.status).toBe(201);
    expect(res.body.post).toMatchObject({ imageAspect: null, imageZoom: null, imagePosition: null });
  });

  it("rounds the zoom to two decimals and accepts the limits", async () => {
    expect((await post({ imageZoom: 1.23456 })).body.post.imageZoom).toBe(1.23);
    expect((await post({ imageZoom: 1 })).status).toBe(201);
    expect((await post({ imageZoom: 3, imagePosition: "0% 100%" })).status).toBe(201);
  });

  it("rejects a shape, zoom or position that isn't valid", async () => {
    for (const bad of [
      { imageAspect: "21:9" },
      { imageAspect: 4 },
      { imageZoom: 0.5 },
      { imageZoom: 3.01 },
      { imageZoom: "2" },
      { imageZoom: true },
      { imagePosition: "50 50" },
      { imagePosition: "101% 50%" },
      { imagePosition: "50% 150%" },
      { imagePosition: "50% 50%; background:url(x)" },
      { imagePosition: { x: 1 } },
    ]) {
      const res = await post(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error).toMatch(/Picture/);
    }
  });

  it("ignores framing on a post with no picture", async () => {
    const res = await agent.post("/api/posts").send({ content: "just words", imageZoom: 2, imagePosition: "10% 10%" });
    expect(res.status).toBe(201);
    expect(res.body.post.imageZoom).toBeNull();
  });
});
