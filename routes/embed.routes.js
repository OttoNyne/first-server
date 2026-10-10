import { Router } from "express";
import mongoose from "mongoose";
import { MediaItem } from "../models/MediaItem.js";
import { User } from "../models/User.js";
import { clientIp } from "../utils/clientIp.js";
import { createLimiter } from "../utils/rateLimit.js";
import { cleanLine } from "../utils/profileFields.js";
import { languageOf } from "../utils/languages.js";
import { escapeHtml, publicSite, shorten } from "./preview.routes.js";

// A piece or a profile card that can be shown inside another website: the site's address /embed/piece/<id> and /embed/profile/<name> (see
// frontend/vercel.json) put one of these pages in an iframe. It is a small page of its own that loads nothing but the picture or media, with no
// scripts, so a page that embeds it can't be given anything but a card.
//
// Two things must both be true before anything is shown: the person's profile is public (not private, not suspended), and they switched
// "let my work be embedded" on. A missing, private, suspended or not-allowed piece or profile all get the same bare page, so none of them can be
// told apart. Pages are cached for five minutes, so switching it off or going private takes effect everywhere within that time.
export const embedRouter = Router();

const limiter = createLimiter({ name: "embed", limit: 600, windowMs: 60 * 60 * 1000 });
const USERNAME = /^[A-Za-z0-9_]{1,30}$/;
const THUMBS = 3;

// The page may load pictures and media over https (and a small picture inline), and nothing else; and unlike every other page of the API,
// it may be framed by any site.
const POLICY = "default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors *";

const WORDS = {
  en: { open: "View on CreativesSelect", by: (name) => `by ${name}`, ai: "AI-generated", openToWork: "Open to work", none: "This isn't available.", play: "Open the piece", profile: "View profile" },
  es: { open: "Ver en CreativesSelect", by: (name) => `de ${name}`, ai: "Generado con IA", openToWork: "Disponible para trabajar", none: "Esto no está disponible.", play: "Abrir la obra", profile: "Ver perfil" },
  ar: { open: "عرض على CreativesSelect", by: (name) => `بواسطة ${name}`, ai: "مُنشأ بالذكاء الاصطناعي", openToWork: "متاح للعمل", none: "هذا غير متاح.", play: "فتح العمل", profile: "عرض الملف الشخصي" },
};

/** An address that is safe to put in a picture or media tag: https, or a small inline picture. Anything else is left out. */
export function safeMediaUrl(value) {
  if (typeof value !== "string" || value.length > 2000) return null;
  if (/^https:\/\/[^\s"'<>\\]+$/.test(value)) return value;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  return null;
}

const STYLE = `
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:#0f0f17;color:#f4f4f8;font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color-scheme:dark}
a{color:#c4b5fd}
.card{display:flex;flex-direction:column;height:100%;min-height:0}
.media{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:#08080d;padding:8px}
.media img,.media video{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px}
.media audio{width:100%}
.plain{flex:1 1 auto;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center}
.bar{display:flex;align-items:center;gap:12px;padding:10px 14px;border-top:1px solid #2a2a3a}
.text{min-width:0;flex:1}
.cap{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f4f4f8}
.by{display:block;font-size:13px;color:#b9b9cc}
.ai{display:inline-block;margin-inline-start:8px;padding:0 6px;border:1px solid #6b6b85;border-radius:999px;font-size:12px;color:#d6d6e4}
.open{white-space:nowrap;font-size:13px;font-weight:600}
.person{display:flex;align-items:center;gap:14px;padding:16px 16px 8px}
.avatar{width:72px;height:72px;border-radius:50%;object-fit:cover;background:#2a2a3a;flex:none}
.name{font-size:18px;font-weight:700;margin:0;overflow-wrap:anywhere}
.handle{color:#b9b9cc;font-size:13px}
.bio{margin:0;padding:0 16px 8px;color:#e6e6f0;overflow-wrap:anywhere}
.tags{margin:0;padding:0 16px 8px;font-size:13px;color:#b9b9cc}
.work{display:inline-block;margin:0 16px 8px;padding:2px 10px;border-radius:999px;background:#2b2150;color:#e9e2ff;font-size:13px}
.thumbs{display:flex;gap:8px;padding:8px 16px;flex:1 1 auto;min-height:0}
.thumbs a{flex:1 1 0;min-width:0;display:block}
.thumbs img{width:100%;height:100%;max-height:140px;object-fit:cover;border-radius:8px;background:#08080d}
`;

function page({ lang = "en", title, body, rtl = lang === "ar" }) {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${rtl ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function send(res, html, status = 200) {
  res.removeHeader("X-Frame-Options"); // helmet's "same site only" is for every other page; this one is made to be framed
  res.set({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": POLICY, "Cache-Control": `public, max-age=${status === 200 ? 300 : 60}`, "X-Robots-Tag": "noindex, nofollow" });
  res.status(status).send(html);
}

const unavailable = (res) => {
  const w = WORDS.en;
  send(res, page({ title: "CreativesSelect", body: `<main class="card"><div class="plain"><p>${escapeHtml(w.none)} <a href="${escapeHtml(publicSite())}/" target="_blank" rel="noopener noreferrer">CreativesSelect</a></p></div></main>` }), 404);
};

/** The person a card is for, if their profile is public and they allow embedding. */
const embeddable = (owner) => Boolean(owner && owner.isPrivate !== true && !owner.suspendedAt && owner.allowEmbeds === true);
const OWNER_FIELDS = "username displayName bio avatarUrl tags isPrivate suspendedAt allowEmbeds language openToWork workOffers";

async function allowed(req, res) {
  if (await limiter.allow(clientIp(req))) return true;
  res.status(429).type("text/plain").send("Too many requests");
  return false;
}

// One portfolio piece: GET /api/embed/piece/:id
embedRouter.get("/piece/:id", async (req, res) => {
  if (!(await allowed(req, res))) return;
  if (!mongoose.isValidObjectId(req.params.id)) return unavailable(res);
  const piece = await MediaItem.findById(req.params.id).populate("owner", OWNER_FIELDS);
  if (!piece || !embeddable(piece.owner)) return unavailable(res);
  const owner = piece.owner;
  const lang = languageOf(owner);
  const w = WORDS[lang];
  const site = publicSite();
  const link = `${site}/u/${encodeURIComponent(owner.username)}?piece=${piece._id}#portfolio`;
  const caption = cleanLine(piece.caption ?? "");
  const src = safeMediaUrl(piece.url);
  let media;
  if (src && piece.type === "image") media = `<a class="media" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(src)}" alt="${escapeHtml(caption || w.play)}"></a>`;
  else if (src && src.startsWith("https://") && piece.type === "video") media = `<div class="media"><video controls preload="metadata" src="${escapeHtml(src)}"></video></div>`;
  else if (src && src.startsWith("https://") && piece.type === "audio") media = `<div class="media"><audio controls preload="metadata" src="${escapeHtml(src)}"></audio></div>`;
  else media = `<div class="plain"><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(caption || w.play)}</a></div>`;
  const ai = piece.isAiImage === true ? `<span class="ai">${escapeHtml(w.ai)}</span>` : "";
  const body = `<main class="card">
${media}
<div class="bar"><div class="text"><span class="cap" dir="auto">${escapeHtml(shorten(caption, 140))}${ai}</span><span class="by">${escapeHtml(w.by(owner.displayName))} · CreativesSelect</span></div><a class="open" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(w.open)}</a></div>
</main>`;
  send(res, page({ lang, title: `${caption || w.play} · ${owner.displayName}`, body }));
});

// A profile card: GET /api/embed/profile/:username
embedRouter.get("/profile/:username", async (req, res) => {
  if (!(await allowed(req, res))) return;
  const name = String(req.params.username);
  if (!USERNAME.test(name)) return unavailable(res);
  const owner = await User.findOne({ username: name.toLowerCase() }).select(OWNER_FIELDS);
  if (!embeddable(owner)) return unavailable(res);
  const lang = languageOf(owner);
  const w = WORDS[lang];
  const site = publicSite();
  const profile = `${site}/u/${encodeURIComponent(owner.username)}`;
  const avatar = safeMediaUrl(owner.avatarUrl);
  const bio = cleanLine(owner.bio ?? "");
  const tags = (owner.tags ?? []).slice(0, 5).map((t) => `#${t}`).join(" ");
  const offers = owner.openToWork === true ? (owner.workOffers ?? []).slice(0, 5).join(", ") : "";
  const pieces = (await MediaItem.find({ owner: owner._id, type: "image" }).sort({ _id: -1 }).limit(12).select("url caption")).filter((p) => safeMediaUrl(p.url)).slice(0, THUMBS);
  const thumbs = pieces
    .map((p) => `<a href="${escapeHtml(`${profile}?piece=${p._id}#portfolio`)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(safeMediaUrl(p.url))}" alt="${escapeHtml(cleanLine(p.caption ?? "") || w.play)}"></a>`)
    .join("");
  const body = `<main class="card">
<div class="person">${avatar ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="">` : `<span class="avatar" aria-hidden="true"></span>`}<div><h1 class="name" dir="auto">${escapeHtml(owner.displayName)}</h1><span class="handle">@${escapeHtml(owner.username)}</span></div></div>
${bio ? `<p class="bio" dir="auto">${escapeHtml(shorten(bio, 200))}</p>` : ""}
${tags ? `<p class="tags" dir="auto">${escapeHtml(tags)}</p>` : ""}
${owner.openToWork === true ? `<span class="work">${escapeHtml(w.openToWork)}${offers ? `: ${escapeHtml(offers)}` : ""}</span>` : ""}
${thumbs ? `<div class="thumbs">${thumbs}</div>` : '<div class="thumbs"></div>'}
<div class="bar"><div class="text"><span class="by">CreativesSelect</span></div><a class="open" href="${escapeHtml(profile)}" target="_blank" rel="noopener noreferrer">${escapeHtml(w.profile)}</a></div>
</main>`;
  send(res, page({ lang, title: `${owner.displayName} (@${owner.username}) · CreativesSelect`, body }));
});
