// "node scripts/mcp-demo.mjs [address]": a short run of the CreativesSelect MCP server with the official MCP client, the way an AI assistant
// would use it: connect, list the tools, look a creator up, find pieces, and ask a question of the project's documents (printing the
// citation). Each call is written to the server's audit log. The address defaults to the live site.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? "https://www.creativesselect.com/api/mcp";
const client = new Client({ name: "creativesselect-demo", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
console.log(`Connected to ${url} as ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}\n`);

const { tools } = await client.listTools();
console.log("Tools:");
for (const t of tools) console.log(`  - ${t.name}: ${t.description.split(". ")[0]}.`);

async function run(name, args) {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  console.log(`\n> ${name} ${JSON.stringify(args)}  (${Date.now() - started} ms${res.isError ? ", error" : ""})`);
  return body;
}

const creators = await run("search_creators", { query: "ceramic", limit: 3 });
console.log(`  ${creators.count} creator(s): ${(creators.creators ?? []).map((c) => c.username).join(", ") || "none"}`);

const pieces = await run("find_pieces", { limit: 3 });
console.log(`  ${pieces.count} piece(s): ${(pieces.pieces ?? []).map((p) => p.caption || p.type).join(" | ") || "none"}`);

const answer = await run("search_docs", { question: "How does a scheduled post avoid being published twice?" });
console.log(`  ${answer.count} passage(s). Best match:`);
if (answer.passages?.[0]) {
  const p = answer.passages[0];
  console.log(`  "${p.snippet.slice(0, 280)}${p.snippet.length > 280 ? "…" : ""}"`);
  console.log(`  Source: ${p.title} › ${p.section}\n  Cite:   ${p.url}`);
}
console.log(`\nAudit ids for these calls: ${[creators, pieces, answer].map((r) => r.requestId).join(", ")}`);
await client.close();
