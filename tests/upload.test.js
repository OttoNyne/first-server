import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { Writable } from "stream";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

// A fake Cloudinary whose upload_stream behaviour each test controls.
let nextResult;
vi.mock("cloudinary", () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      destroy: vi.fn().mockResolvedValue({ result: "ok" }),
      upload: vi.fn(),
      upload_stream: (options, callback) =>
        new Writable({
          write(chunk, enc, done) {
            done();
          },
          final(done) {
            const { error, result } = nextResult();
            callback(error, result);
            done();
          },
        }),
    },
  },
}));

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

describe("POST /api/media/upload", () => {
  let app;
  let StoredAsset;
  let agent;
  let userId;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ StoredAsset } = await import("../models/StoredAsset.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
    agent = request.agent(app);
    const res = await agent.post("/api/auth/register").send({
      email: "up@example.com",
      username: "uploader",
      password: "password123",
      displayName: "Uploader",
    });
    userId = res.body.user.id;
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const send = (purpose = "portfolio", type = "image/png") =>
    agent.post(`/api/media/upload?purpose=${purpose}`).attach("file", PNG, { filename: "pic.png", contentType: type });

  it("requires sign-in", async () => {
    nextResult = () => ({ result: {} });
    const res = await request(app).post("/api/media/upload").attach("file", PNG, "pic.png");
    expect(res.status).toBe(401);
  });

  it("stores the file, returns its URL, and records it in the ledger as the user's upload", async () => {
    nextResult = () => ({
      result: {
        secure_url: "https://res.cloudinary.com/demo/image/upload/v1/creativeselect/portfolio/abc.png",
        public_id: "creativeselect/portfolio/abc",
        bytes: 70,
      },
    });
    const res = await send("portfolio");
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/abc\.png$/);
    expect(res.body.mediaItem.type).toBe("image");

    const asset = await StoredAsset.findOne({ owner: userId });
    expect(asset).toMatchObject({ publicId: "creativeselect/portfolio/abc", kind: "upload", resourceType: "image" });
  });

  it("records audio as a video-type resource (Cloudinary's name for it)", async () => {
    nextResult = () => ({
      result: {
        secure_url: "https://res.cloudinary.com/demo/video/upload/v1/creativeselect/tracks/song.mp3",
        public_id: "creativeselect/tracks/song",
        bytes: 70,
      },
    });
    const res = await send("tracks", "audio/mpeg");
    expect(res.status).toBe(201);
    expect((await StoredAsset.findOne({ owner: userId })).resourceType).toBe("video");
  });

  it("rejects a file type that isn't allowed for the purpose", async () => {
    nextResult = () => ({ result: {} });
    const res = await send("avatars", "audio/mpeg");
    expect(res.status).toBe(400);
    expect(await StoredAsset.countDocuments()).toBe(0);
  });

  it("turns Cloudinary's 'file too large' error into a clear 413, not a 500", async () => {
    nextResult = () => ({ error: { http_code: 400, message: "File size too large. Got 11534336. Maximum is 10485760." } });
    const res = await send();
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large.*10 MB/i);
    expect(await StoredAsset.countDocuments()).toBe(0);
  });

  it("reports other storage failures as a 502 without leaking internals", async () => {
    nextResult = () => ({ error: { http_code: 500, message: "secret-internal-detail: api_key rejected" } });
    const res = await send();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/try again/i);
    expect(JSON.stringify(res.body)).not.toMatch(/secret-internal-detail|api_key/);
  });
});
