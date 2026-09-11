import { MockAIProvider } from "./MockAIProvider.js";

let instance;

export function getAIProvider() {
  if (!instance) {
    // A "real" (Claude/etc.) provider isn't implemented upstream either —
    // AI_PROVIDER always resolves to the mock provider for now.
    instance = new MockAIProvider();
  }
  return instance;
}
