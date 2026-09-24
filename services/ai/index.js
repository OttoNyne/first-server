import { MockAIProvider } from "./MockAIProvider.js";
import { CloudflareAIProvider } from "./CloudflareAIProvider.js";

let instance;

// Real image generation is used when both Cloudflare credentials are set;
// otherwise (local dev, tests, or a deploy without them) everything falls
// back to the deterministic mock so the app still works and costs nothing.
export function isRealImageProviderConfigured() {
  return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
}

export function getAIProvider() {
  if (!instance) {
    instance = isRealImageProviderConfigured()
      ? new CloudflareAIProvider({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          apiToken: process.env.CLOUDFLARE_API_TOKEN,
          model: process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell",
        })
      : new MockAIProvider();
  }
  return instance;
}
