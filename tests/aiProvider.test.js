import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cloudflare's reply is stubbed and Cloudinary is mocked, so this exercises only
// the provider's own handling: what it returns, and how it reports failures.
const upload = vi.fn();
vi.mock("cloudinary", () => ({ v2: { config: vi.fn(), uploader: { upload: (...a) => upload(...a), destroy: vi.fn() } } }));

const { CloudflareAIProvider } = await import("../services/ai/CloudflareAIProvider.js");

const provider = new CloudflareAIProvider({ accountId: "acct", apiToken: "tok", model: "@cf/test/model" });
const imageReply = () =>
  new Response(JSON.stringify({ result: { image: Buffer.from("fake-jpeg-bytes").toString("base64") } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  upload.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => imageReply()));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CloudflareAIProvider.generateImage", () => {
  it("generates, stores the picture on Cloudinary, and returns its URL and id", async () => {
    upload.mockResolvedValue({ secure_url: "https://res.cloudinary.com/demo/image/upload/v1/creativeselect/ai-generated/x.jpg", public_id: "creativeselect/ai-generated/x" });
    const result = await provider.generateImage({ prompt: "a red kite" });

    expect(result).toEqual({ url: "https://res.cloudinary.com/demo/image/upload/v1/creativeselect/ai-generated/x.jpg", publicId: "creativeselect/ai-generated/x" });
    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/jpeg;base64,/), expect.objectContaining({ folder: "creativeselect/ai-generated" }));
    const [, init] = fetch.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ prompt: "a red kite" });
  });

  it("truncates an over-long prompt before sending it", async () => {
    upload.mockResolvedValue({ secure_url: "https://x/y.jpg", public_id: "y" });
    await provider.generateImage({ prompt: "p".repeat(900) });
    expect(JSON.parse(fetch.mock.calls[0][1].body).prompt).toHaveLength(500);
  });

  it("says storage is unavailable (503) when Cloudinary refuses the account, without leaking details", async () => {
    upload.mockRejectedValue({ http_code: 401, message: "action is disabled for qypmp28l" });
    const err = await provider.generateImage({ prompt: "a red kite" }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/temporarily unavailable/i);
    expect(err.message).not.toMatch(/qypmp28l|disabled for/);
    // and it is logged loudly for the operator
    expect(console.error.mock.calls.flat().join(" ")).toMatch(/STORAGE UNAVAILABLE/);
  });

  it("keeps the generic 'try again' failure (502) for other storage errors", async () => {
    upload.mockRejectedValue({ http_code: 500, message: "boom" });
    const err = await provider.generateImage({ prompt: "a red kite" }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/try again/i);
  });

  it("reports Cloudflare's own failures without touching Cloudinary", async () => {
    fetch.mockImplementation(async () => new Response("nope", { status: 500 }));
    const err = await provider.generateImage({ prompt: "a red kite" }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(upload).not.toHaveBeenCalled();
  });

  it("tells users the free allowance ran out (503) rather than to retry", async () => {
    fetch.mockImplementation(async () => new Response('{"errors":[{"code":4006}]}', { status: 429 }));
    const err = await provider.generateImage({ prompt: "a red kite" }).catch((e) => e);
    expect(err.status).toBe(503);
  });
});
