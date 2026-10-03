import { v2 as cloudinary } from "cloudinary";
import { MockAIProvider } from "./MockAIProvider.js";
import { isStorageUnavailable, logStorageProblem, STORAGE_UNAVAILABLE_MESSAGE } from "../../utils/storageErrors.js";

const MAX_PROMPT_CHARS = 500;
// A wallpaper made from a reference photo uses a model that takes pictures as input (FLUX.2 klein); one made from words
// alone uses the ordinary image model. Both are 16:9, which is what a wallpaper wants.
const REFERENCE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const WALLPAPER_STYLE = ", wide cinematic wallpaper, rich detail, no text, no watermark";
const WALLPAPER_SIZE = { width: "1024", height: "576" };
const SQUARE_SIZE = { width: "1024", height: "1024" };
// How closely to follow the reference photo, said to the model in words (it has no strength dial).
const CLOSENESS_INSTRUCTION = {
  close: "Keep the composition, shapes and colours of the reference image closely, and apply this to it: ",
  balanced: "Use the reference image as the starting point, keeping its main subject, and make this: ",
  loose: "Take loose inspiration from the reference image (its mood and palette) to create this new scene: ",
};

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

  // A picture for a post, avatar or portfolio: from the description alone, or — with a reference photo — the photo reshaped
  // to match the description, as closely as `closeness` ("close", "balanced" or "loose") asks.
  async generateImage({ prompt, reference, closeness = "balanced" }) {
    const text = prompt.slice(0, MAX_PROMPT_CHARS);
    if (!reference) return this.runImageModel(this.model, { prompt: text, steps: 4 });
    return this.generateFromReference({ text, reference, closeness, size: SQUARE_SIZE });
  }

  // A picture for a profile wallpaper (wide, with wallpaper wording), optionally from a reference photo.
  async generateWallpaper({ prompt, reference, closeness = "balanced" }) {
    const text = (prompt.slice(0, MAX_PROMPT_CHARS - WALLPAPER_STYLE.length) + WALLPAPER_STYLE).slice(0, MAX_PROMPT_CHARS);
    if (!reference) return this.runImageModel(this.model, { prompt: text, steps: 4 });
    return this.generateFromReference({ text, reference, closeness, size: WALLPAPER_SIZE });
  }

  generateFromReference({ text, reference, closeness, size }) {
    const form = new FormData();
    form.append("prompt", ((CLOSENESS_INSTRUCTION[closeness] ?? CLOSENESS_INSTRUCTION.balanced) + text).slice(0, MAX_PROMPT_CHARS + 120));
    form.append("input_image_0", new Blob([reference.buffer], { type: reference.mimetype }), "reference");
    form.append("width", size.width);
    form.append("height", size.height);
    return this.runImageModel(process.env.CLOUDFLARE_REFERENCE_MODEL || REFERENCE_MODEL, form);
  }

  async runImageModel(model, input) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${model}`;

    let res;
    try {
      // a form (a reference photo travels with it) sets its own content type; anything else is sent as JSON
      const isForm = input instanceof FormData;
      res = await fetch(url, {
        method: "POST",
        headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), Authorization: `Bearer ${this.apiToken}` },
        body: isForm ? input : JSON.stringify(input),
        signal: AbortSignal.timeout(90_000),
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
