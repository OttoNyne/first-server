import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { sniffImageType } from "../utils/imageSniff.js";

// These tests must never reach the real image service or storage, whatever credentials the machine has: with the
// Cloudflare settings blank the app uses its built-in stand-in.
vi.hoisted(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "";
  process.env.CLOUDFLARE_API_TOKEN = "";
});

// A real (tiny) PNG, JPEG and WebP header: only the first bytes matter to the check.
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a tiny pretend picture")]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("a tiny pretend picture")]);
const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 pretend")]);
const GIF_BYTES = Buffer.from("GIF89a-pretend-animation");

async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("picking out a picture by its bytes", () => {
  it("recognises JPEG, PNG and WebP, and nothing else", () => {
    expect(sniffImageType(PNG_BYTES)).toBe("image/png");
    expect(sniffImageType(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffImageType(WEBP_BYTES)).toBe("image/webp");
    expect(sniffImageType(GIF_BYTES)).toBeNull();
    expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImageType(Buffer.from("MZ executable"))).toBeNull();
    expect(sniffImageType(Buffer.alloc(3))).toBeNull();
    expect(sniffImageType("not a buffer")).toBeNull();
  });
});

describe("POST /api/ai/wallpaper", () => {
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

  const svgOf = (url) => Buffer.from(url.split(",")[1], "base64").toString();

  it("needs a signed-in person", async () => {
    expect((await request(app).post("/api/ai/wallpaper").field("prompt", "a harbor")).status).toBe(401);
  });

  it("makes a wallpaper from a description alone", async () => {
    const { agent } = await signup(app, "alice");
    const res = await agent.post("/api/ai/wallpaper").field("prompt", "a calm harbor at dusk");
    expect(res.status).toBe(200);
    expect(res.body.usedReference).toBe(false);
    expect(res.body.url).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(svgOf(res.body.url)).not.toContain("data-reference");
  });

  it("makes a different wallpaper when a reference photo is given, and says it used it", async () => {
    const { agent } = await signup(app, "alice");
    const without = await agent.post("/api/ai/wallpaper").field("prompt", "a calm harbor at dusk");
    const withPhoto = await agent.post("/api/ai/wallpaper").field("prompt", "a calm harbor at dusk").attach("reference", PNG_BYTES, { filename: "photo.png", contentType: "image/png" });
    expect(withPhoto.status).toBe(200);
    expect(withPhoto.body.usedReference).toBe(true);
    expect(svgOf(withPhoto.body.url)).toContain("data-reference");
    expect(withPhoto.body.url).not.toBe(without.body.url);
  });

  it("accepts JPEG and WebP photos, and the three ways of following the photo", async () => {
    const { agent } = await signup(app, "alice");
    for (const [bytes, type, closeness] of [[JPEG_BYTES, "image/jpeg", "close"], [WEBP_BYTES, "image/webp", "balanced"], [PNG_BYTES, "image/png", "loose"]]) {
      const res = await agent.post("/api/ai/wallpaper").field("prompt", "forest").field("closeness", closeness).attach("reference", bytes, { filename: "p", contentType: type });
      expect(res.status, closeness).toBe(200);
    }
  });

  it("asks for a description, and not an enormous one", async () => {
    const { agent } = await signup(app, "alice");
    expect((await agent.post("/api/ai/wallpaper").field("prompt", "   ")).status).toBe(400);
    expect((await agent.post("/api/ai/wallpaper")).status).toBe(400);
    const long = await agent.post("/api/ai/wallpaper").field("prompt", "x".repeat(501));
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/500 characters/);
  });

  it("checks the photo by its contents, not its name or claimed type", async () => {
    const { agent } = await signup(app, "alice");
    const attach = (bytes, name, type) => agent.post("/api/ai/wallpaper").field("prompt", "forest").attach("reference", bytes, { filename: name, contentType: type });
    for (const [bytes, name, type] of [
      [Buffer.from("just some text pretending"), "photo.png", "image/png"],
      [Buffer.from("<svg onload='alert(1)'></svg>"), "photo.png", "image/png"],
      [GIF_BYTES, "anim.gif", "image/gif"],
      [Buffer.from("MZ not an image at all"), "photo.jpg", "image/jpeg"],
    ]) {
      const res = await attach(bytes, name, type);
      expect(res.status, name).toBe(400);
      expect(res.body.error).toMatch(/JPEG, PNG or WebP/);
    }
  });

  it("refuses a photo over 4 MB", async () => {
    const { agent } = await signup(app, "alice");
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(4 * 1024 * 1024)]);
    const res = await agent.post("/api/ai/wallpaper").field("prompt", "forest").attach("reference", big, { filename: "big.png", contentType: "image/png" });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/under 4 MB/);
  });

  it("refuses more than one photo or an unknown way of following it", async () => {
    const { agent } = await signup(app, "alice");
    const two = await agent
      .post("/api/ai/wallpaper")
      .field("prompt", "forest")
      .attach("reference", PNG_BYTES, { filename: "a.png", contentType: "image/png" })
      .attach("reference", PNG_BYTES, { filename: "b.png", contentType: "image/png" });
    expect(two.status).toBe(400);
    const bad = await agent.post("/api/ai/wallpaper").field("prompt", "forest").field("closeness", "extreme");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/close, balanced or loose/);
  });
});

describe("a profile's wallpaper motion", () => {
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

  it("starts as none, can be set to any of the motions, and is shown on the profile", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bobby");
    expect(alice.user.wallpaperMotion).toBe("none");
    for (const motion of ["zoom", "drift", "pan", "pulse", "none"]) {
      const res = await alice.agent.patch("/api/profiles/me").send({ wallpaperMotion: motion });
      expect(res.status, motion).toBe(200);
      expect(res.body.user.wallpaperMotion).toBe(motion);
    }
    await alice.agent.patch("/api/profiles/me").send({ wallpaperMotion: "drift" });
    expect((await bob.agent.get("/api/profiles/alice")).body.user.wallpaperMotion).toBe("drift");
  });

  it("refuses a motion it doesn't know, and keeps the old one", async () => {
    const alice = await signup(app, "alice");
    await alice.agent.patch("/api/profiles/me").send({ wallpaperMotion: "zoom" });
    for (const bad of ["spin", "", null, 3, "ZOOM", { $ne: "x" }, ["zoom"]]) {
      const res = await alice.agent.patch("/api/profiles/me").send({ wallpaperMotion: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await alice.agent.get("/api/profiles/alice")).body.user.wallpaperMotion).toBe("zoom");
  });

  it("can be changed together with the wallpaper itself", async () => {
    const alice = await signup(app, "alice");
    const res = await alice.agent.patch("/api/profiles/me").send({ wallpaperUrl: "https://images.example.com/w.jpg", wallpaperType: "image", wallpaperMotion: "pan" });
    expect(res.body.user).toMatchObject({ wallpaperUrl: "https://images.example.com/w.jpg", wallpaperMotion: "pan" });
  });

  it("is hidden along with the rest of a private profile", async () => {
    const alice = await signup(app, "alice");
    const stranger = await signup(app, "stranger");
    await alice.agent.patch("/api/profiles/me").send({ wallpaperMotion: "zoom", isPrivate: true });
    const res = await stranger.agent.get("/api/profiles/alice");
    // a stranger gets either nothing or the bare identity — never the wallpaper or how it moves
    expect(res.body.user?.wallpaperMotion).toBeUndefined();
    expect(res.body.user?.wallpaperUrl).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("zoom");
  });
});
