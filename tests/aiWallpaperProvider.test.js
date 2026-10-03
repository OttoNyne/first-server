import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cloudflare's reply is stubbed and Cloudinary is mocked, so this exercises only the provider's own handling of wallpapers:
// what it sends, what it returns, and how it reports failures.
const upload = vi.fn();
vi.mock("cloudinary", () => ({ v2: { config: vi.fn(), uploader: { upload: (...a) => upload(...a), destroy: vi.fn() } } }));

const { CloudflareAIProvider } = await import("../services/ai/CloudflareAIProvider.js");

const provider = new CloudflareAIProvider({ accountId: "acct", apiToken: "tok", model: "@cf/test/model" });
const imageReply = () =>
  new Response(JSON.stringify({ result: { image: Buffer.from("fake-jpeg-bytes").toString("base64") } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const stored = { secure_url: "https://res.cloudinary.com/demo/image/upload/v1/creativeselect/ai-generated/w.jpg", public_id: "creativeselect/ai-generated/w" };
const reference = { buffer: Buffer.from("pretend-png-bytes"), mimetype: "image/png" };

beforeEach(() => {
  upload.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => imageReply()));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.CLOUDFLARE_REFERENCE_MODEL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CloudflareAIProvider.generateWallpaper", () => {
  it("from a description alone: uses the ordinary image model with wallpaper wording, and stores the result", async () => {
    upload.mockResolvedValue(stored);
    const result = await provider.generateWallpaper({ prompt: "a calm harbor" });
    expect(result).toEqual({ url: stored.secure_url, publicId: stored.public_id });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain("/ai/run/@cf/test/model");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.prompt).toMatch(/^a calm harbor, wide cinematic wallpaper/);
    expect(body.prompt).toMatch(/no text/);
    expect(body.prompt.length).toBeLessThanOrEqual(500);
  });

  it("with a reference photo: sends it with the description to the model that takes pictures, as a form", async () => {
    upload.mockResolvedValue(stored);
    const result = await provider.generateWallpaper({ prompt: "a calm harbor", reference, closeness: "close" });
    expect(result.url).toBe(stored.secure_url);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain("/ai/run/@cf/black-forest-labs/flux-2-klein-4b");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).not.toHaveProperty("Content-Type"); // the form sets its own, with its boundary
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.body.get("prompt")).toMatch(/^Keep the composition, shapes and colours of the reference image closely/);
    expect(init.body.get("prompt")).toContain("a calm harbor");
    expect(init.body.get("width")).toBe("1024");
    expect(init.body.get("height")).toBe("576");
    const sent = init.body.get("input_image_0");
    expect(sent.type).toBe("image/png");
    expect(Buffer.from(await sent.arrayBuffer()).toString()).toBe("pretend-png-bytes");
  });

  it("says how closely to follow the photo in words, a different way for each choice", async () => {
    upload.mockResolvedValue(stored);
    const prompts = [];
    for (const closeness of ["close", "balanced", "loose", "unknown"]) {
      await provider.generateWallpaper({ prompt: "forest", reference, closeness });
      prompts.push(fetch.mock.calls.at(-1)[1].body.get("prompt"));
    }
    expect(new Set(prompts.slice(0, 3)).size).toBe(3);
    expect(prompts[3]).toBe(prompts[1]); // anything unrecognised is treated as balanced
  });

  it("can be pointed at a different reference model", async () => {
    upload.mockResolvedValue(stored);
    process.env.CLOUDFLARE_REFERENCE_MODEL = "@cf/black-forest-labs/flux-2-klein-9b";
    await provider.generateWallpaper({ prompt: "forest", reference });
    expect(fetch.mock.calls[0][0]).toContain("/ai/run/@cf/black-forest-labs/flux-2-klein-9b");
  });

  it("keeps an over-long description within the limit", async () => {
    upload.mockResolvedValue(stored);
    await provider.generateWallpaper({ prompt: "p".repeat(900) });
    expect(JSON.parse(fetch.mock.calls[0][1].body).prompt.length).toBeLessThanOrEqual(500);
  });

  it("reports a model the account can't use as temporarily unavailable, without Cloudflare's wording", async () => {
    fetch.mockImplementation(async () => new Response('{"errors":[{"message":"This account is not allowed to access the model","code":5018}]}', { status: 403 }));
    const err = await provider.generateWallpaper({ prompt: "forest", reference }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.message).not.toMatch(/not allowed to access|5018|account/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it("reports a photo the model can't read as a failure to try again, without Cloudflare's wording", async () => {
    fetch.mockImplementation(async () => new Response('{"errors":[{"message":"Invalid input image[0]: unable to decode image file","code":3030}]}', { status: 400 }));
    const err = await provider.generateWallpaper({ prompt: "forest", reference }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).not.toMatch(/decode|3030/);
  });
});
