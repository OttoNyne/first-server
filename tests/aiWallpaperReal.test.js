import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

// Here the real image service is "configured", but the network and the picture storage are stand-ins, so this checks how
// the route behaves in production (limits, storage records) without spending anything.
vi.hoisted(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
  process.env.CLOUDFLARE_API_TOKEN = "tok";
});
const upload = vi.hoisted(() => vi.fn());
const destroy = vi.hoisted(() => vi.fn());
vi.mock("cloudinary", () => ({ v2: { config: vi.fn(), uploader: { upload, destroy, upload_stream: vi.fn() } } }));

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pretend picture")]);

describe("POST /api/ai/wallpaper with the real image service configured", () => {
  let app, StoredAsset, realFetch;
  let n = 0;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ StoredAsset } = await import("../models/StoredAsset.js"));
    realFetch = globalThis.fetch;
  });
  beforeEach(async () => {
    await clearTestDb();
    upload.mockReset();
    destroy.mockReset();
    destroy.mockResolvedValue({ result: "ok" });
    upload.mockImplementation(async () => ({ secure_url: `https://res.cloudinary.com/demo/image/upload/creativeselect/ai-generated/w${++n}.jpg`, public_id: `creativeselect/ai-generated/w${n}` }));
    // only the calls to Cloudflare are stubbed; anything else passes straight through
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("api.cloudflare.com")) {
        return new Response(JSON.stringify({ result: { image: Buffer.from("fake-image").toString("base64") } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(url, init);
    });
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await clearTestDb();
    await disconnectTestDb();
  });

  async function signup(name) {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
    return { agent, user: res.body.user };
  }
  const cloudflareCalls = () => globalThis.fetch.mock.calls.filter(([u]) => String(u).includes("api.cloudflare.com"));

  it("stores the picture, records who made it (so it is cleaned up with the wallpaper) and returns its address", async () => {
    const { agent, user } = await signup("alice");
    const res = await agent.post("/api/ai/wallpaper").field("prompt", "a calm harbor").attach("reference", PNG_BYTES, { filename: "p.png", contentType: "image/png" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: expect.stringMatching(/^https:\/\/res\.cloudinary\.com\//), usedReference: true });
    const asset = await StoredAsset.findOne({ url: res.body.url });
    expect(String(asset.owner)).toBe(user.id);
    expect(asset.kind).toBe("ai");
    expect(cloudflareCalls()[0][0]).toContain("flux-2-klein-4b");
  });

  it("uses the ordinary image model, and doesn't send any photo, when there isn't one", async () => {
    const { agent } = await signup("alice");
    await agent.post("/api/ai/wallpaper").field("prompt", "a calm harbor");
    expect(cloudflareCalls()[0][0]).toContain("flux-1-schnell");
    expect(cloudflareCalls()[0][1].body).not.toBeInstanceOf(FormData);
  });

  it("allows 6 an hour per person, then says to try later, and counts only people who asked", async () => {
    const alice = await signup("alice");
    const bob = await signup("bobby");
    for (let i = 0; i < 6; i++) expect((await alice.agent.post("/api/ai/wallpaper").field("prompt", `harbor ${i}`)).status, `request ${i + 1}`).toBe(200);
    const seventh = await alice.agent.post("/api/ai/wallpaper").field("prompt", "one more");
    expect(seventh.status).toBe(429);
    expect(seventh.body.error).toMatch(/6 per hour/);
    expect(cloudflareCalls()).toHaveLength(6); // the refused one never reached the image service
    expect((await bob.agent.post("/api/ai/wallpaper").field("prompt", "my turn")).status).toBe(200);
  });

  describe("discarding a picture that wasn't used", () => {
    const make = async (who) => (await who.agent.post("/api/ai/wallpaper").field("prompt", "harbor")).body.url;

    it("removes it from storage", async () => {
      const alice = await signup("alice");
      const url = await make(alice);
      expect((await alice.agent.post("/api/ai/discard").send({ url })).status).toBe(204);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(destroy.mock.calls[0][0]).toMatch(/^creativeselect\/ai-generated\/w\d+$/);
      expect(await StoredAsset.countDocuments({ url })).toBe(0);
    });

    it("keeps it if it is in use as the person's wallpaper", async () => {
      const alice = await signup("alice");
      const url = await make(alice);
      await alice.agent.patch("/api/profiles/me").send({ wallpaperUrl: url, wallpaperType: "image" });
      expect((await alice.agent.post("/api/ai/discard").send({ url })).status).toBe(204);
      expect(destroy).not.toHaveBeenCalled();
      expect(await StoredAsset.countDocuments({ url })).toBe(1);
    });

    it("never removes someone else's picture, or anything it doesn't know about", async () => {
      const alice = await signup("alice");
      const mallory = await signup("mallory");
      const url = await make(alice);
      expect((await mallory.agent.post("/api/ai/discard").send({ url })).status).toBe(204);
      expect((await mallory.agent.post("/api/ai/discard").send({ url: "https://res.cloudinary.com/demo/image/upload/not-recorded.jpg" })).status).toBe(204);
      expect(destroy).not.toHaveBeenCalled();
      expect(await StoredAsset.countDocuments({ url })).toBe(1);
    });

    it("needs a sign-in and an address", async () => {
      const alice = await signup("alice");
      expect((await request(app).post("/api/ai/discard").send({ url: "https://x/y.jpg" })).status).toBe(401);
      expect((await alice.agent.post("/api/ai/discard").send({})).status).toBe(400);
      expect((await alice.agent.post("/api/ai/discard").send({ url: { $ne: "" } })).status).toBe(400);
    });
  });

  it("doesn't use up an allowance on a request that is refused for being wrong", async () => {
    const { agent } = await signup("alice");
    for (let i = 0; i < 10; i++) await agent.post("/api/ai/wallpaper").field("prompt", "forest").attach("reference", Buffer.from("not a picture"), { filename: "x.png", contentType: "image/png" });
    expect((await agent.post("/api/ai/wallpaper").field("prompt", "forest")).status).toBe(200);
    expect(cloudflareCalls()).toHaveLength(1);
  });
});
