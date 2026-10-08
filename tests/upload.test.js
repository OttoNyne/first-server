import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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

  it("accepts the audio types iPhones use (m4a, aac, x-wav) for songs", async () => {
    for (const type of ["audio/x-m4a", "audio/m4a", "audio/aac", "audio/x-wav", "audio/mp4", "audio/mp3"]) {
      nextResult = () => ({
        result: { secure_url: "https://res.cloudinary.com/demo/video/upload/v1/creativeselect/tracks/s.m4a", public_id: "creativeselect/tracks/s", bytes: 70 },
      });
      const res = await send("tracks", type);
      expect(res.status, type).toBe(201);
    }
  });

  it("still keeps non-audio files out of songs, and audio out of picture uploads", async () => {
    nextResult = () => ({ result: {} });
    expect((await send("tracks", "application/pdf")).status).toBe(400);
    expect((await send("tracks", "image/png")).status).toBe(400);
    expect((await send("portfolio", "audio/x-m4a")).status).toBe(400);
    expect((await send("avatars", "audio/aac")).status).toBe(400);
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

  it("reports a storage account that refuses uploads as 503 (retrying can't help), not as a generic failure", async () => {
    for (const http_code of [401, 403, 420]) {
      nextResult = () => ({ error: { http_code, message: "action is disabled for some-cloud" } });
      const res = await send();
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/temporarily unavailable/i);
      expect(JSON.stringify(res.body)).not.toMatch(/some-cloud|disabled for/);
    }
    expect(await StoredAsset.countDocuments()).toBe(0);
  });

  it("reports other storage failures as a 502 without leaking internals", async () => {
    nextResult = () => ({ error: { http_code: 500, message: "secret-internal-detail: api_key rejected" } });
    const res = await send();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/try again/i);
    expect(JSON.stringify(res.body)).not.toMatch(/secret-internal-detail|api_key/);
  });

  describe("size limits: a minute of video gets more room than a picture, and a file over its limit is cut off as it arrives", () => {
    let limits;
    beforeAll(async () => {
      ({ UPLOAD_LIMITS: limits } = await import("../middleware/upload.js"));
    });
    const saved = {};
    beforeEach(() => Object.assign(saved, limits));
    afterEach(() => Object.assign(limits, saved));
    const bytes = (n) => Buffer.alloc(n, 1);
    const sendBytes = (n, type, purpose = "portfolio", name = "file.bin") => agent.post(`/api/media/upload?purpose=${purpose}`).attach("file", bytes(n), { filename: name, contentType: type });
    const ok = () => ({ result: { secure_url: "https://res.cloudinary.com/demo/x.mp4", public_id: "creativeselect/portfolio/x", bytes: 1, duration: 10 } });

    it("has a bigger limit for video than for anything else, and the real numbers are what the plan allows", () => {
      expect(limits.video).toBe(100 * 1024 * 1024);
      expect(limits.other).toBe(30 * 1024 * 1024);
      expect(limits.video).toBeGreaterThan(limits.other);
    });

    it("lets a video through that a picture of the same size could not be", async () => {
      limits.other = 2_000;
      limits.video = 20_000;
      nextResult = ok;
      expect((await sendBytes(10_000, "video/mp4", "portfolio", "clip.mp4")).status).toBe(201);
      nextResult = ok;
      const picture = await sendBytes(10_000, "image/png", "portfolio", "pic.png");
      expect(picture.status).toBe(413);
      expect(picture.body.error).toMatch(/too large/i);
    });

    it("refuses a video over its own limit with a message about video, stores nothing, and records nothing", async () => {
      limits.video = 5_000;
      nextResult = ok;
      const res = await sendBytes(50_000, "video/mp4", "portfolio", "clip.mp4");
      expect(res.status).toBe(413);
      expect(res.body.error).toMatch(/video is too large/i);
      expect(res.body.error).toMatch(/MB/);
      expect(await StoredAsset.countDocuments()).toBe(0);
    });

    it("applies the lower limit to audio and to pictures for every purpose, not just the portfolio", async () => {
      limits.other = 3_000;
      limits.video = 30_000;
      for (const [purpose, type, name] of [["avatars", "image/png", "a.png"], ["wallpapers", "image/jpeg", "w.jpg"], ["tracks", "audio/mpeg", "t.mp3"], ["comments", "image/png", "c.png"]]) {
        nextResult = ok;
        const res = await sendBytes(10_000, type, purpose, name);
        expect(res.status, purpose).toBe(413);
      }
      expect(await StoredAsset.countDocuments()).toBe(0);
    });

    it("still answers promptly after cutting a file off, and the next upload works", async () => {
      limits.other = 1_000;
      nextResult = ok;
      expect((await sendBytes(200_000, "image/png", "portfolio", "big.png")).status).toBe(413);
      nextResult = ok;
      expect((await sendBytes(500, "image/png", "portfolio", "small.png")).status).toBe(201);
    });

    it("accepts a file exactly at its limit", async () => {
      limits.other = 4_000;
      nextResult = ok;
      expect((await sendBytes(4_000, "image/png", "portfolio", "exact.png")).status).toBe(201);
    });
  });
});
