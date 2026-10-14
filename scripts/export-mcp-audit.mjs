// "node scripts/export-mcp-audit.mjs [--since 2026-10-14T00:00:00Z] [--out docs/MCP_AUDIT_LOG.md]": writes the MCP server's audit log as a Markdown
// file that can be committed and linked: one row per tool call, oldest first, with what was asked, whether it worked, how many results
// came back, which document sections an answer was grounded in, and how long it took. It only reads (one collection, nothing about people:
// the log holds no address or account), using MONGODB_URI from the environment.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import mongoose from "mongoose";
import { McpAuditEntry } from "../models/McpAuditEntry.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const since = arg("since", null);
const out = arg("out", "docs/MCP_AUDIT_LOG.md");
if (since && Number.isNaN(Date.parse(since))) throw new Error("--since must be a date such as 2026-10-14T00:00:00Z");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI isn't set");

await mongoose.connect(process.env.MONGODB_URI);
const entries = await McpAuditEntry.find(since ? { at: { $gte: new Date(since) } } : {}).sort({ at: 1 }).lean();
await mongoose.disconnect();

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const asked = (args) => Object.entries(args ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ") || "—";
const sources = (list) => (list?.length ? list.map((u) => u.replace("https://github.com/OttoNyne/", "")).join("<br>") : "—");

const lines = [
  "# CreativesSelect MCP server — audit log",
  "",
  `Exported ${new Date().toISOString()} from the server's own audit log (\`McpAuditEntry\`): **${entries.length}** tool call${entries.length === 1 ? "" : "s"}${since ? ` since ${since}` : ""}, oldest first.`,
  "",
  "Every call to the server's tools is written here whether it worked or not. An entry holds the tool, what was asked (each text cut to 100 characters), the outcome, how many results came back, the document sections an answer was grounded in, how long it took, and the caller's own label. It never holds an address or an account. The log lives in the database and is readable only by an administrator (`GET /api/mcp/audit`); entries delete themselves after 180 days.",
  "",
  "| # | Time (UTC) | Tool | Asked | Outcome | Results | Grounded in | ms | Request id |",
  "|---|---|---|---|---|---|---|---|---|",
  ...entries.map((e, i) => `| ${i + 1} | ${e.at.toISOString().replace("T", " ").slice(0, 19)} | \`${e.tool}\` | ${cell(asked(e.args))} | ${e.status === "ok" ? "ok" : `error: ${cell(e.error)}`} | ${e.resultCount} | ${cell(sources(e.sources))} | ${e.durationMs} | \`${e.requestId}\` |`),
  "",
];
writeFileSync(out, lines.join("\n"));
console.log(`Wrote ${entries.length} entries to ${out}`);
