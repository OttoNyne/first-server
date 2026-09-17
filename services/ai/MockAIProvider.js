import crypto from "crypto";
import { searchOpenverseImages } from "./imageSearch.js";

const BIO_TEMPLATES = [
  "Just here making {topic} happen ✨",
  "{topic} enthusiast, always creating.",
  "Living for {topic} and good vibes 🌊",
];
const CAPTION_TEMPLATES = [
  "{topic} 🔥",
  "A little {topic} moment.",
  "Can't stop thinking about {topic}.",
];
const BLURB_TEMPLATES = [
  "This is all about {topic} — come check it out.",
  "{topic}: the story so far.",
  "Diving deep into {topic} today.",
];

const EMOJI = ["✨", "🔥", "🌊", "💫", "🎨"];

function templateFor(kind) {
  if (kind === "caption") return CAPTION_TEMPLATES;
  if (kind === "blurb") return BLURB_TEMPLATES;
  return BIO_TEMPLATES;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashToColors(input) {
  const hash = crypto.createHash("md5").update(input).digest("hex");
  return [`#${hash.slice(0, 6)}`, `#${hash.slice(6, 12)}`];
}

export class MockAIProvider {
  async generateText({ prompt, kind }) {
    await delay(300 + Math.random() * 300);
    const templates = templateFor(kind);
    const template = templates[Math.floor(Math.random() * templates.length)];
    const emoji = EMOJI[Math.floor(Math.random() * EMOJI.length)];
    return { text: `${template.replace("{topic}", prompt.trim())} ${emoji}` };
  }

  async generateImage({ prompt, kind, live }) {
    const [c1, c2] = hashToColors(prompt);
    const animate = kind === "wallpaper" && live;
    const svg = animate
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${c1}"><animate attributeName="stop-color" values="${c1};${c2};${c1}" dur="6s" repeatCount="indefinite"/></stop><stop offset="100%" stop-color="${c2}"><animate attributeName="stop-color" values="${c2};${c1};${c2}" dur="6s" repeatCount="indefinite"/></stop></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/></svg>`;

    const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    return { url };
  }

  async searchImages(query) {
    return searchOpenverseImages(query);
  }
}
