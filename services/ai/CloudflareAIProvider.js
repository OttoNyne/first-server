import { v2 as cloudinary } from "cloudinary";
import { MockAIProvider } from "./MockAIProvider.js";
import { isStorageUnavailable, logStorageProblem, STORAGE_UNAVAILABLE_MESSAGE } from "../../utils/storageErrors.js";

const MAX_PROMPT_CHARS = 500;

function aiError(message, status = 502) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const MAX_TEXT_CHARS = 300;

const TEXT_INSTRUCTIONS = {
  bio: "Write a short, catchy social-media profile bio (max 160 characters) for a creative person based on the user's topic.",
  caption: "Write a short, engaging social-media post caption (max 200 characters) based on the user's topic.",
  blurb: "Write a brief, engaging 1-2 sentence description based on the user's topic.",
};

// Never forward Cloudflare's raw body to the client. Auth problems and an
// exhausted free daily allowance (code 4006) can't be fixed by retrying, so
// don't tell users to.
async function failFromResponse(res, what) {
  const body = await res.text().catch(() => "");
  console.error(`Cloudflare ${what} generation failed:`, res.status, body);
  if ([401, 403].includes(res.status) || body.includes("4006")) {
    throw aiError(`${what} generation is temporarily unavailable`, 503);
  }
  if (res.status === 429) throw aiError(`${what} generation is busy, try again in a moment`, 429);
  throw aiError(`${what} generation failed, try again`);
}

// Real image (FLUX.1 schnell by default) and text (Llama 3.1) generation via
// Cloudflare Workers AI. Photo search still delegates to Openverse.
export class CloudflareAIProvider extends MockAIProvider {
  constructor({ accountId, apiToken, model }) {
    super();
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.model = model;
  }

  async generateText({ prompt, kind }) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${TEXT_MODEL}`;

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content: `${TEXT_INSTRUCTIONS[kind] || TEXT_INSTRUCTIONS.bio} Reply with only the text itself, no quotes or preamble.`,
            },
            { role: "user", content: prompt.slice(0, MAX_TEXT_CHARS) },
          ],
          max_tokens: 160,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw aiError("Text generation timed out or is unavailable right now");
    }
    if (!res.ok) await failFromResponse(res, "Text");

    const text = (await res.json())?.result?.response;
    if (typeof text !== "string" || !text.trim()) throw aiError("Text generation returned no text");
    return { text: text.trim().replace(/^["“]|["”]$/g, "") };
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

    if (!res.ok) await failFromResponse(res, "Image");

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
      return { url: uploaded.secure_url, publicId: uploaded.public_id };
    } catch (err) {
      logStorageProblem("upload of a generated image", err);
      if (isStorageUnavailable(err)) throw aiError(STORAGE_UNAVAILABLE_MESSAGE, 503);
      throw aiError("Couldn't save the generated image, try again");
    }
  }
}
