import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

// Never reaches the real image service or storage, whatever credentials the machine has: with the Cloudflare settings
// blank the app uses its built-in stand-in.
vi.hoisted(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "";
  process.env.CLOUDFLARE_API_TOKEN = "";
});

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a tiny pretend picture")]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("another pretend picture")]);

describe("POST /api/ai/image: with or without a reference photo", () => {
  let app, agent;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
    agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email: "alice@example.com", username: "alice", password: "password123", displayName: "alice" });
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const svgOf = (url) => Buffer.from(url.split(",")[1], "base64").toString();

  it("still takes a plain JSON description, exactly as before", async () => {
    const res = await agent.post("/api/ai/image").send({ prompt: "a red kite", kind: "post" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: expect.stringMatching(/^data:image\/svg\+xml;base64,/), usedReference: false });
    expect(svgOf(res.body.url)).not.toContain("data-reference");
  });

  it("asks for a description, whichever way it is sent", async () => {
    expect((await agent.post("/api/ai/image").send({ kind: "post" })).status).toBe(400);
    expect((await agent.post("/api/ai/image").send({ prompt: 5 })).status).toBe(400);
    expect((await agent.post("/api/ai/image").field("kind", "post")).status).toBe(400);
  });

  it("takes a reference photo with the description as a form, and makes a different picture", async () => {
    const plain = await agent.post("/api/ai/image").send({ prompt: "a red kite", kind: "post" });
    const withPhoto = await agent.post("/api/ai/image").field("prompt", "a red kite").field("kind", "post").attach("reference", PNG_BYTES, { filename: "p.png", contentType: "image/png" });
    expect(withPhoto.status).toBe(200);
    expect(withPhoto.body.usedReference).toBe(true);
    expect(svgOf(withPhoto.body.url)).toContain("data-reference");
    expect(withPhoto.body.url).not.toBe(plain.body.url);
  });

  it("works for every kind of picture and every way of following the photo", async () => {
    for (const kind of ["avatar", "post", "wallpaper"]) {
      for (const [closeness, bytes, type] of [["close", PNG_BYTES, "image/png"], ["balanced", JPEG_BYTES, "image/jpeg"], ["loose", PNG_BYTES, "image/png"]]) {
        const res = await agent.post("/api/ai/image").field("prompt", "forest").field("kind", kind).field("closeness", closeness).attach("reference", bytes, { filename: "p", contentType: type });
        expect(res.status, `${kind} ${closeness}`).toBe(200);
      }
    }
  });

  it("makes a different picture from a different photo", async () => {
    const make = (bytes) => agent.post("/api/ai/image").field("prompt", "forest").attach("reference", bytes, { filename: "p", contentType: "image/png" });
    expect((await make(PNG_BYTES)).body.url).not.toBe((await make(JPEG_BYTES)).body.url);
    expect((await make(PNG_BYTES)).body.url).toBe((await make(PNG_BYTES)).body.url);
  });

  it("checks the photo by its contents, and its size", async () => {
    const attach = (bytes, type = "image/png") => agent.post("/api/ai/image").field("prompt", "forest").attach("reference", bytes, { filename: "p", contentType: type });
    for (const bytes of [Buffer.from("just some text"), Buffer.from("<svg onload='alert(1)'></svg>"), Buffer.from("GIF89a-pretend")]) {
      const res = await attach(bytes);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/JPEG, PNG or WebP/);
    }
    const big = await attach(Buffer.concat([PNG_BYTES, Buffer.alloc(4 * 1024 * 1024)]));
    expect(big.status).toBe(413);
    const odd = await agent.post("/api/ai/image").field("prompt", "forest").field("closeness", "extreme").attach("reference", PNG_BYTES, { filename: "p", contentType: "image/png" });
    expect(odd.status).toBe(400);
  });

  it("needs a signed-in person", async () => {
    expect((await request(app).post("/api/ai/image").send({ prompt: "x" })).status).toBe(401);
    expect((await request(app).post("/api/ai/image").field("prompt", "x").attach("reference", PNG_BYTES, { filename: "p", contentType: "image/png" })).status).toBe(401);
  });

  it("still makes the animated mock wallpaper when asked, as JSON", async () => {
    const res = await agent.post("/api/ai/image").send({ prompt: "waves", kind: "wallpaper", live: true });
    expect(svgOf(res.body.url)).toContain("<animate");
  });
});
