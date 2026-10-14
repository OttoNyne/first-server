// "node scripts/mcp-eval.mjs [address] [--markdown out.md] [--json out.json] [--label text]": evaluates the MCP server's search_docs tool end to end
// with the official client, against the questions in mcp/eval/golden.json. For each question it asks for the top 3 passages and checks whether
// the section that answers it is among them (hit@1, hit@3), and that questions the documents don't cover come back empty (abstention). The same
// questions are also scored by a deliberately naive baseline (count of the question's words in a section, no stop words, no stemming, no
// weighting) over the same passages, so the number means something. Every call goes through the server and is written to its audit log.
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { allSections } from "../mcp/knowledge.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : null;
};
const address = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--"))) ?? "https://www.creativesselect.com/api/mcp";
const golden = JSON.parse(readFileSync(new URL("../mcp/eval/golden.json", import.meta.url), "utf8"));

const engine = flag("engine");
const offline = engine ? await import(new URL(`file:///${engine.replace(/\\\\/g, "/")}`).href) : null;
const client = offline ? null : new Client({ name: "creativesselect-mcp-eval", version: "1.0.0" });
if (client) await client.connect(new StreamableHTTPClientTransport(new URL(address), { requestInit: { headers: { "User-Agent": "creativesselect-mcp-eval/1.0" } } }));

const accepted = (q) => [{ source: q.source, section: q.section }, ...(q.alt ?? [])];
const matches = (passage, q) => accepted(q).some((a) => passage.source === a.source && passage.section.toLowerCase().includes(a.section.toLowerCase()));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)];

// the naive baseline over the very same sections
const sections = await allSections();
function naive(question) {
  const terms = [...new Set(question.toLowerCase().match(/\p{L}+/gu) ?? [])];
  return sections
    .map(({ s, sec }) => {
      const text = `${sec.heading} ${sec.text}`.toLowerCase();
      return { source: s.id, section: sec.heading, score: terms.filter((t) => text.includes(t)).length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

const rows = [];
for (const q of golden.questions) {
  const started = Date.now();
  let body;
  if (offline) body = { passages: await offline.searchDocs(q.q, 3), requestId: "(offline)" };
  else body = JSON.parse((await client.callTool({ name: "search_docs", arguments: { question: q.q, limit: 3 } })).content[0].text);
  const ms = Date.now() - started;
  const passages = body.passages ?? [];
  const base = naive(q.q);
  if (q.kind === "out_of_scope") {
    rows.push({ ...q, ms, requestId: body.requestId, returned: passages.length, ok: passages.length === 0, naiveOk: base.length === 0, top: passages[0] ? `${passages[0].title} › ${passages[0].section}` : "(nothing)" });
  } else {
    const at = passages.findIndex((p) => matches(p, q));
    const baseAt = base.findIndex((p) => matches(p, q));
    rows.push({ ...q, ms, requestId: body.requestId, rank: at < 0 ? null : at + 1, hit1: at === 0, hit3: at >= 0, naiveHit1: baseAt === 0, naiveHit3: baseAt >= 0, top: passages[0] ? `${passages[0].title} › ${passages[0].section}` : "(nothing)", cite: passages[at >= 0 ? at : 0]?.url ?? null });
  }
}
if (client) await client.close();

const rate = (list, key) => `${list.filter((r) => r[key]).length}/${list.length}`;
const pct = (list, key) => (list.length ? Math.round((100 * list.filter((r) => r[key]).length) / list.length) : 0);
const direct = rows.filter((r) => r.kind === "direct");
const para = rows.filter((r) => r.kind === "paraphrase");
const inScope = [...direct, ...para];
const out = rows.filter((r) => r.kind === "out_of_scope");
const summary = {
  address,
  at: new Date().toISOString(),
  questions: rows.length,
  hit3_direct: rate(direct, "hit3"),
  hit1_direct: rate(direct, "hit1"),
  hit3_paraphrase: rate(para, "hit3"),
  hit3_all_in_scope: rate(inScope, "hit3"),
  hit3_all_in_scope_pct: pct(inScope, "hit3"),
  abstained_out_of_scope: rate(out, "ok"),
  baseline_hit3_direct: rate(direct, "naiveHit3"),
  baseline_hit3_paraphrase: rate(para, "naiveHit3"),
  baseline_hit3_all_in_scope: rate(inScope, "naiveHit3"),
  baseline_abstained_out_of_scope: rate(out, "naiveOk"),
  latency_ms_median: median(rows.map((r) => r.ms)),
  latency_ms_p95: p95(rows.map((r) => r.ms)),
};
console.log(JSON.stringify(summary, null, 2));
for (const r of rows) console.log(`${r.id} ${r.kind.padEnd(12)} ${r.kind === "out_of_scope" ? (r.ok ? "abstained  " : `ANSWERED(${r.returned})`) : r.hit1 ? "hit@1      " : r.hit3 ? `hit@${r.rank}      ` : "MISS       "} ${String(r.ms).padStart(5)} ms  ${r.top}`);

if (flag("json")) writeFileSync(flag("json"), JSON.stringify({ summary, rows }, null, 2));
if (flag("markdown")) {
  const mark = (ok) => (ok ? "✅" : "❌");
  const lines = [
    `# search_docs evaluation: results`,
    "",
    `${flag("label") ?? "Run"} against \`${address}\` on ${summary.at.slice(0, 10)}, through the official MCP client (each call is in the server's audit log). ${golden.questions.length} questions from \`mcp/eval/golden.json\`; the "baseline" column is a naive word-count scorer over the same passages.`,
    "",
    "| Measure | search_docs | Naive baseline |",
    "|---|---|---|",
    `| Right section in the top 3, direct questions | **${summary.hit3_direct}** | ${summary.baseline_hit3_direct} |`,
    `| Right section in the top 3, paraphrased questions | **${summary.hit3_paraphrase}** | ${summary.baseline_hit3_paraphrase} |`,
    `| Right section in the top 3, all in-scope (${inScope.length}) | **${summary.hit3_all_in_scope}** (${summary.hit3_all_in_scope_pct}%) | ${summary.baseline_hit3_all_in_scope} |`,
    `| Right section first, direct questions | ${summary.hit1_direct} | — |`,
    `| Out-of-scope questions answered with nothing | **${summary.abstained_out_of_scope}** | ${summary.baseline_abstained_out_of_scope} |`,
    `| Latency per call, median / 95th percentile (client side, over the internet) | ${summary.latency_ms_median} ms / ${summary.latency_ms_p95} ms | — |`,
    "",
    "## Every question",
    "",
    "| id | kind | question | expected | rank | baseline | top result | ms | audit id |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      r.kind === "out_of_scope"
        ? `| ${r.id} | out of scope | ${r.q} | nothing | ${mark(r.ok)} ${r.ok ? "empty" : `answered (${r.returned})`} | ${mark(r.naiveOk)} | ${r.top} | ${r.ms} | \`${r.requestId}\` |`
        : `| ${r.id} | ${r.kind} | ${r.q} | ${r.source} › ${r.section} | ${mark(r.hit3)} ${r.rank ?? "miss"} | ${mark(r.naiveHit3)} | ${r.top} | ${r.ms} | \`${r.requestId}\` |`
    ),
    "",
  ];
  writeFileSync(flag("markdown"), lines.join("\n"));
}
