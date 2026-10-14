import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// What the `search_docs` tool answers from: the project's own writing (its architecture notes, its security review and this API's README),
// split by heading so every passage can be cited as a document and a section. The two big documents live in the frontend repository, so they
// are read from GitHub (fixed addresses, never ones a caller names), kept for an hour, and the last good copy is used if GitHub can't be
// reached. Nothing a caller types is ever used as an address or a file name.
const OWNER = "OttoNyne";
export const SOURCES = [
  { id: "architecture", title: "Architecture", repo: "CreativesSelect", path: "docs/ARCHITECTURE.md" },
  { id: "security-review", title: "Security review", repo: "CreativesSelect", path: "docs/SECURITY_REVIEW.md" },
  { id: "api-readme", title: "API README", repo: "first-server", path: "README.md", local: "README.md" },
];

const HOUR = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_DOC_CHARS = 2_000_000;

let fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: "text/plain" } });
/** Replace how documents are fetched (tests). */
export function setDocFetcher(fn) {
  fetcher = fn ?? ((url) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: "text/plain" } }));
  cache.clear();
}

const cache = new Map(); // source id → { at, sections }
const here = dirname(fileURLToPath(import.meta.url));

export const rawUrl = (s) => `https://raw.githubusercontent.com/${OWNER}/${s.repo}/master/${s.path}`;
export const blobUrl = (s) => `https://github.com/${OWNER}/${s.repo}/blob/master/${s.path}`;

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces to hyphens. */
export function slugOf(heading) {
  return heading
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** A markdown text cut into sections at its headings: { heading, level, slug, text }. Text before the first heading is the document's own. */
export function splitSections(markdown, fallbackTitle) {
  const sections = [];
  let current = { heading: fallbackTitle, level: 0, slug: "", lines: [] };
  let inFence = false;
  for (const line of String(markdown).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      sections.push(current);
      current = { heading: m[2].replace(/[`*_]/g, "").trim(), level: m[1].length, slug: slugOf(m[2]), lines: [] };
    } else current.lines.push(line);
  }
  sections.push(current);
  return sections
    .map((s) => ({ heading: s.heading, level: s.level, slug: s.slug, text: s.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() }))
    .filter((s) => s.text.length >= 40);
}

async function load(source) {
  const hit = cache.get(source.id);
  if (hit && Date.now() - hit.at < HOUR) return hit.sections;
  try {
    let text;
    if (source.local) text = await readFile(join(here, "..", source.local), "utf8");
    else {
      const res = await fetcher(rawUrl(source));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    }
    const sections = splitSections(text.slice(0, MAX_DOC_CHARS), source.title);
    cache.set(source.id, { at: Date.now(), sections });
    return sections;
  } catch (err) {
    if (hit) return hit.sections; // the last good copy
    console.error(`Couldn't read ${source.id} for the MCP server:`, err.message);
    return [];
  }
}

/** Every section of every document, with its source (for the evaluation script, which compares scorers on the same passages). */
export async function allSections() {
  const loaded = await Promise.all(SOURCES.map(async (s) => ({ s, sections: await load(s) })));
  return loaded.flatMap(({ s, sections }) => sections.map((sec) => ({ s, sec })));
}

const STOP = new Set("a an and are as at be by can do does for from how i if in is it its me my of on or so that the their there this to was we what when where which who why will with you your have has had been being".split(" "));
/** A word with its commonest endings taken off, so "published" and "publishing" are looked for as "publish". */
const stem = (w) => (w.length > 5 ? w.replace(/(ing|ed|es|ly|s)$/u, "") : w);
const words = (text) => (String(text).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).filter((w) => !STOP.has(w)).map(stem);

/** The sentence-ish window of a section that has the most of the words, cut to about `max` characters. */
function snippetOf(text, terms, max = 650) {
  // a paragraph, or one item of a list
  const paragraphs = text.split(/\n{2,}|\n(?=\s*(?:[-*]|\d+\.) )/);
  let best = paragraphs[0] ?? "";
  let bestScore = -1;
  for (const p of paragraphs) {
    const lower = p.toLowerCase();
    const score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  const flat = best.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The passages that best answer a question, each with where it came from: { source, title, section, url, snippet, score }.
 *
 * A section is scored with BM25: each word of the question counts for how rare it is across the documents (a word found in few sections says
 * more than one found in many), repeated mentions count with diminishing returns, a word in the heading counts triple, and long sections are
 * not favoured just for being long. A section is only returned if the words it holds make up at least half of the weight of the whole
 * question: a question whose important words appear nowhere gets an empty list (an honest "the documents don't cover it") rather than the
 * least-bad section.
 */
export const MIN_COVERAGE = 0.5;
const K1 = 1.2;
const B = 0.75;
export async function searchDocs(question, limit = 4) {
  const terms = [...new Set(words(question))];
  if (terms.length === 0) return [];
  const loaded = await Promise.all(SOURCES.map(async (s) => ({ s, sections: await load(s) })));
  const all = loaded.flatMap(({ s, sections }) =>
    sections.map((sec) => {
      const body = sec.text.toLowerCase();
      const head = sec.heading.toLowerCase();
      return { s, sec, body, head, length: Math.max(1, (body.match(/\S+/g) ?? []).length) };
    })
  );
  const averageLength = all.reduce((n, d) => n + d.length, 0) / Math.max(1, all.length);
  const N = all.length;
  const idf = new Map(
    terms.map((t) => {
      const df = all.filter((d) => d.body.includes(t) || d.head.includes(t)).length;
      return [t, Math.log(1 + (N - df + 0.5) / (df + 0.5))];
    })
  );
  const totalWeight = terms.reduce((n, t) => n + idf.get(t), 0);
  const scored = [];
  for (const d of all) {
    let score = 0;
    let found = 0;
    for (const t of terms) {
      const tf = d.body.split(t).length - 1 + 3 * (d.head.includes(t) ? 1 : 0);
      if (tf === 0) continue;
      found += idf.get(t);
      score += idf.get(t) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / averageLength)));
    }
    if (found > 0 && found / totalWeight >= MIN_COVERAGE) scored.push({ s: d.s, sec: d.sec, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ s, sec, score }) => ({
    source: s.id,
    title: s.title,
    section: sec.heading,
    url: sec.slug ? `${blobUrl(s)}#${sec.slug}` : blobUrl(s),
    snippet: snippetOf(sec.text, terms),
    score: Math.round(score * 10) / 10,
  }));
}
