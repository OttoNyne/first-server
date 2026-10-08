import { Router } from "express";
import { User } from "../models/User.js";
import { clientIp } from "../utils/clientIp.js";
import { createLimiter } from "../utils/rateLimit.js";
import { clientOrigins } from "../utils/origins.js";
import { isLanguage } from "../utils/languages.js";
import { cleanLine } from "../utils/profileFields.js";

// What a link to a profile looks like when it is shared (messages, social media), and which profiles a search engine may list.
//
// The site is a single-page app, so a link's preview has to be made by the server: the website sends /p/<username> here (see
// frontend/vercel.json). Someone who opens the link is sent on to the real profile at once; a program that makes previews reads the
// tags. Only a public profile's name, bio and picture are ever put in the page (a private, suspended or missing profile all get the
// same bare page, so none of them can be told apart), and a profile is only offered to search engines if its owner switched that on.
export const previewRouter = Router();

const limiter = createLimiter({ name: "preview", limit: 600, windowMs: 60 * 60 * 1000 });
const USERNAME = /^[A-Za-z0-9_]{1,30}$/;
export const MAX_DESCRIPTION = 200;
const MAX_SITEMAP = 5000;

/** The address the site is really served on: the one with www when there is one (the bare domain only redirects to it), so links, canonical addresses and the sitemap all name the same host. */
const publicSite = () => clientOrigins().find((o) => o.startsWith("https://www.")) ?? clientOrigins()[0];

/** Text made safe to put in a page, in an attribute or between tags: nothing in it can be read as markup. */
export function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** At most `max` characters (counting whole characters, never cutting one in half), with an ellipsis if cut. */
export function shorten(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

const SENTENCE = {
  en: (name) => `${name} is on CreativesSelect: portfolio, music and more.`,
  es: (name) => `${name} está en CreativesSelect: portafolio, música y más.`,
  ar: (name) => `${name} على CreativesSelect: معرض أعمال وموسيقى والمزيد.`,
};
const GENERIC = "A home for creatives: customizable profiles, friends, groups, AI-assisted posts, and a Help wanted board.";

/** The page: tags for programs that make previews, and a way on to the real profile for people. Everything put in is escaped by this function. */
export function previewPage({ title, description, image, url, target, index, lang = "en", type = "website" }) {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const u = escapeHtml(url);
  const go = escapeHtml(target);
  const img = image ? `\n<meta property="og:image" content="${escapeHtml(image)}">\n<meta name="twitter:image" content="${escapeHtml(image)}">` : "";
  return `<!doctype html>
<html lang="${isLanguage(lang) ? lang : "en"}">
<head>
<meta charset="utf-8">
<title>${t}</title>
<meta name="description" content="${d}">
<meta name="robots" content="${index ? "index,follow" : "noindex,nofollow"}">
<link rel="canonical" href="${u}">
<meta http-equiv="refresh" content="0;url=${go}">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="CreativesSelect">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">${img}
<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
</head>
<body>
<p><a href="${go}">${t}</a></p>
</body>
</html>
`;
}

function send(res, html, { index, maxAge = 300 }) {
  // The page loads nothing, so it may load nothing. The API's usual policy also says "upgrade-insecure-requests", which would have
  // Safari turn the way on to the profile into https even where the site is served over plain http (a developer's own machine).
  res.set({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Cache-Control": `public, max-age=${maxAge}`, "X-Robots-Tag": index ? "all" : "noindex, nofollow" });
  res.status(200).send(html);
}

// The preview of one profile: GET /api/preview/profile/:username
previewRouter.get("/profile/:username", async (req, res) => {
  if (!(await limiter.allow(clientIp(req)))) return res.status(429).type("text/plain").send("Too many requests");
  const site = publicSite();
  const name = String(req.params.username);
  const home = { title: "CreativesSelect", description: GENERIC, image: `${site}/og-image.png`, url: `${site}/`, target: `${site}/`, index: false };
  if (!USERNAME.test(name)) return send(res, previewPage(home), { index: false });

  const target = `${site}/u/${encodeURIComponent(name.toLowerCase())}`;
  const user = await User.findOne({ username: name.toLowerCase() }).select("username displayName bio avatarUrl tags isPrivate suspendedAt listInSearchEngines language openToWork workOffers");
  // a private, suspended or missing profile all get this same bare page
  if (!user || user.isPrivate || user.suspendedAt) return send(res, previewPage({ ...home, url: target, target }), { index: false });

  const bio = cleanLine(user.bio ?? "");
  const tags = (user.tags ?? []).slice(0, 5).join(", ");
  const offers = user.openToWork ? (user.workOffers ?? []).slice(0, 5).join(", ") : "";
  const lang = isLanguage(user.language) ? user.language : "en";
  const description = shorten(bio || [SENTENCE[lang](user.displayName), tags && `#${tags.replaceAll(", ", " #")}`, offers && `· ${offers}`].filter(Boolean).join(" "), MAX_DESCRIPTION);
  const image = /^https:\/\/\S+$/.test(user.avatarUrl ?? "") ? user.avatarUrl : `${site}/og-image.png`;
  const index = user.listInSearchEngines === true;
  send(res, previewPage({ title: `${user.displayName} (@${user.username}) · CreativesSelect`, description, image, url: target, target, index, lang, type: "profile" }), { index });
});

// The profiles whose owners have asked to be listed by search engines: GET /api/preview/sitemap.xml
previewRouter.get("/sitemap.xml", async (req, res) => {
  const site = publicSite();
  const people = await User.find({ listInSearchEngines: true, isPrivate: { $ne: true }, suspendedAt: null }).sort({ updatedAt: -1 }).limit(MAX_SITEMAP).select("username updatedAt");
  const urls = people.map((p) => `<url><loc>${escapeHtml(`${site}/u/${encodeURIComponent(p.username)}`)}</loc><lastmod>${p.updatedAt.toISOString().slice(0, 10)}</lastmod></url>`);
  res.set({ "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${escapeHtml(site)}/</loc></url>\n${urls.join("\n")}\n</urlset>\n`);
});
