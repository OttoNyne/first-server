import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cloudflare's reply is stubbed and Cloudinary is mocked: this checks what the provider sends for a plain picture
// (post, avatar, portfolio) made with or without a reference photo.
const upload = vi.fn();
vi.mock("cloudinary", () => ({ v2: { config: vi.fn(), uploader: { upload: (...a) => upload(...a), destroy: vi.fn() } } }));

const { CloudflareAIProvider } = await import("../services/ai/CloudflareAIProvider.js");

const provider = new CloudflareAIProvider({ accountId: "acct", apiToken: "tok", model: "@cf/test/model" });
const stored = { secure_url: "https://res.cloudinary.com/demo/image/upload/v1/creativeselect/ai-generated/i.jpg", public_id: "creativeselect/ai-generated/i" };
const reference = { buffer: Buffer.from("pretend-jpeg-bytes"), mimetype: "image/jpeg" };

beforeEach(() => {
  upload.mockReset();
  upload.mockResolvedValue(stored);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => new Response(JSON.stringify({ result: { image: Buffer.from("fake").toString("base64") } }), { status: 200, headers: { "content-type": "application/json" } }))
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CloudflareAIProvider.generateImage with a reference photo", () => {
  it("without one, is exactly what it always was: the ordinary model, JSON, the description as given", async () => {
    await provider.generateImage({ prompt: "a red kite" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain("/ai/run/@cf/test/model");
    expect(JSON.parse(init.body)).toEqual({ prompt: "a red kite", steps: 4 });
  });

  it("with one, sends it with the description to the model that takes pictures, as a square form", async () => {
    const result = await provider.generateImage({ prompt: "a red kite", reference, closeness: "loose" });
    expect(result).toEqual({ url: stored.secure_url, publicId: stored.public_id });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain("/ai/run/@cf/black-forest-labs/flux-2-klein-4b");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).not.toHaveProperty("Content-Type");
    expect(init.body.get("prompt")).toMatch(/^Take loose inspiration from the reference image/);
    expect(init.body.get("prompt")).toContain("a red kite");
    expect(init.body.get("prompt")).not.toMatch(/wallpaper/); // the wallpaper wording is for wallpapers only
    expect([init.body.get("width"), init.body.get("height")]).toEqual(["1024", "1024"]);
    expect(init.body.get("input_image_0").type).toBe("image/jpeg");
  });

  it("treats an unrecognised closeness as balanced, and caps an over-long description", async () => {
    await provider.generateImage({ prompt: "p".repeat(900), reference, closeness: "whatever" });
    const prompt = fetch.mock.calls[0][1].body.get("prompt");
    expect(prompt).toMatch(/^Use the reference image as the starting point/);
    expect(prompt.length).toBeLessThanOrEqual(620);
  });

  it("reports failures without Cloudflare's wording", async () => {
    fetch.mockImplementation(async () => new Response('{"errors":[{"message":"Invalid input image[0]","code":3030}]}', { status: 400 }));
    const err = await provider.generateImage({ prompt: "a red kite", reference }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).not.toMatch(/3030|Invalid input/);
    expect(upload).not.toHaveBeenCalled();
  });
});
