import { v2 as cloudinary } from "cloudinary";
import { MockAIProvider } from "./MockAIProvider.js";

const MAX_PROMPT_CHARS = 500;

function aiError(message, status = 502) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Real image generation via Cloudflare Workers AI (FLUX.1 schnell by
// default). Text generation and photo search still delegate to the
// mock/Openverse paths — only images were requested to be real.
export class CloudflareAIProvider extends MockAIProvider {
  constructor({ accountId, apiToken, model }) {
    super();
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.model = model;
  }

  async generateImage({ prompt }) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` },
        body: JSON.stringify({ prompt: prompt.slice(0, MAX_PROMPT_CHARS), steps: 4 }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw aiError("Image generation timed out or is unavailable right now");
    }

    if (!res.ok) {
      // Never forward Cloudflare's raw body to the client.
      const body = await res.text().catch(() => "");
      console.error("Cloudflare image generation failed:", res.status, body);
      // Auth problems and an exhausted free daily allowance (code 4006) can't
      // be fixed by retrying, so don't tell users to.
      if ([401, 403].includes(res.status) || body.includes("4006")) {
        throw aiError("Image generation is temporarily unavailable", 503);
      }
      if (res.status === 429) throw aiError("Image generation is busy, try again in a moment", 429);
      throw aiError("Image generation failed, try again");
    }

    // FLUX models reply with JSON { result: { image: <base64 jpeg> } };
    // Stable Diffusion models reply with the raw image bytes.
    let dataUri;
    if ((res.headers.get("content-type") || "").includes("application/json")) {
      const b64 = (await res.json())?.result?.image;
      if (!b64) throw aiError("Image generation returned no image");
      dataUri = `data:image/jpeg;base64,${b64}`;
    } else {
      const bytes = Buffer.from(await res.arrayBuffer());
      dataUri = `data:image/png;base64,${bytes.toString("base64")}`;
    }

    // Persist to Cloudinary rather than storing a multi-megabyte base64 string
    // on a user/post document.
    try {
      const uploaded = await cloudinary.uploader.upload(dataUri, {
        folder: "creativeselect/ai-generated",
        resource_type: "image",
      });
      return { url: uploaded.secure_url };
    } catch (err) {
      console.error("Cloudinary upload of generated image failed:", err);
      throw aiError("Couldn't save the generated image, try again");
    }
  }
}
