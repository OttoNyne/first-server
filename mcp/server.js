import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpAuditEntry } from "../models/McpAuditEntry.js";
import { askDocs, findPieces, getCreator, searchCreators } from "./tools.js";

// The CreativesSelect MCP server: a few read-only tools over what is already public on the site, and over the project's own documents, so an AI
// assistant can look people and work up and answer questions about how the site is built with a citation. Every call is written to the audit
// log (models/McpAuditEntry.js) whether it worked or not. Ranges (how long a word may be, how many results) are enforced inside the tools, not
// in the schemas, so a call that is out of range reaches the log as an error like any other.
export const SERVER_INFO = { name: "creativesselect", version: "1.0.0" };
const AUDIT_DAYS = 180;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const expiry = () => new Date(Date.now() + AUDIT_DAYS * 24 * 60 * 60 * 1000);

/** What was asked, kept short for the log: each text cut to 100 characters, and only text, numbers and yes/no values. */
export function summariseArgs(args) {
  const out = {};
  if (!args || typeof args !== "object") return out;
  for (const [key, value] of Object.entries(args).slice(0, 12)) {
    const name = key.slice(0, 40);
    if (typeof value === "string") out[name] = value.length > 100 ? `${value.slice(0, 99)}…` : value;
    else if (typeof value === "number" || typeof value === "boolean") out[name] = value;
  }
  return out;
}

/** The tools, each as { name, title, description, shape, run, count, sources } so the server, the audit log and the tests read the same list. */
export const TOOLS = [
  {
    name: "search_creators",
    title: "Search creators",
    description: "Find public CreativesSelect members by words in their name, username, bio or tags, by a tag, or those open to work. Returns names, short bios, tags, what they offer and a link to each profile.",
    shape: {
      query: z.string().optional().describe("Words to look for in a name, username, bio or tag (at most 60 characters)"),
      tag: z.string().optional().describe("A tag a member has chosen, such as ceramics (at most 40 characters)"),
      open_to_work: z.boolean().optional().describe("Only people who say they are open to work"),
      limit: z.number().optional().describe("How many to return (default 5, at most 10)"),
    },
    run: (a) => searchCreators({ query: a.query, tag: a.tag, openToWork: a.open_to_work, limit: a.limit }),
    count: (r) => r.count,
    sources: () => [],
  },
  {
    name: "get_creator",
    title: "Get a creator",
    description: "One public member by username: their card, how many pieces they have, their newest pieces and posts, each with a link. Private or missing profiles are not available.",
    shape: { username: z.string().describe("The member's username (letters, numbers and underscores, at most 30)") },
    run: (a) => getCreator({ username: a.username }),
    count: () => 1,
    sources: (r) => [r.creator.profileUrl],
  },
  {
    name: "find_pieces",
    title: "Find portfolio pieces",
    description: "Newest public portfolio pieces, optionally about a tag, with words in the caption, or of one kind (image, audio, video, embed). Each has its maker and a link to it.",
    shape: {
      tag: z.string().optional().describe("A hashtag the piece's caption uses, without the # (at most 40 characters)"),
      query: z.string().optional().describe("Words in the caption (at most 60 characters)"),
      type: z.string().optional().describe("One of image, audio, video or embed"),
      limit: z.number().optional().describe("How many to return (default 5, at most 10)"),
    },
    run: (a) => findPieces({ tag: a.tag, query: a.query, type: a.type, limit: a.limit }),
    count: (r) => r.count,
    sources: () => [],
  },
  {
    name: "search_docs",
    title: "Search the project's documents",
    description:
      "Answer a question about how CreativesSelect is built, secured and run from the project's own architecture notes, security review and API README. Returns the best passages, each with the document, the section and a link to cite. An empty list means the documents don't cover it.",
    shape: {
      question: z.string().describe("The question, in plain words (at most 300 characters)"),
      limit: z.number().optional().describe("How many passages (default 4, at most 10)"),
    },
    run: (a) => askDocs({ question: a.question, limit: a.limit }),
    count: (r) => r.count,
    sources: (r) => [...new Set(r.passages.map((p) => p.url))],
  },
];

/**
 * A server for one request (stateless: nothing is kept between calls). `client` is the caller's own label, for the log. `calls.count` is how
 * many tool calls actually ran, so the route can tell when the protocol turned one away first.
 */
export function buildMcpServer({ client = "" } = {}) {
  const server = new McpServer(SERVER_INFO);
  const calls = { count: 0 };
  for (const tool of TOOLS) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.shape, annotations: { title: tool.title, ...READ_ONLY } }, async (args) => {
      calls.count += 1;
      const started = Date.now();
      const entry = { requestId: randomUUID(), tool: tool.name, args: summariseArgs(args), client: String(client).slice(0, 80) };
      const record = (extra) => McpAuditEntry.create({ ...entry, durationMs: Date.now() - started, at: new Date(), expireAt: expiry(), ...extra }).catch((err) => console.error("Couldn't write an MCP audit entry:", err.message));
      try {
        const result = await tool.run(args);
        await record({ status: "ok", resultCount: tool.count(result), sources: tool.sources(result) });
        return { content: [{ type: "text", text: JSON.stringify({ ...result, requestId: entry.requestId }, null, 2) }] };
      } catch (err) {
        const message = String(err?.message ?? err).slice(0, 200);
        await record({ status: "error", error: message });
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message, requestId: entry.requestId }) }] };
      }
    });
  }
  return { server, calls };
}

/** A tool call the protocol turned away before it ran (an argument of the wrong kind): logged too, so the log really has every call. */
export function auditRejected({ tool, args, client, error }) {
  return McpAuditEntry.create({
    requestId: randomUUID(),
    tool: String(tool ?? "unknown").slice(0, 60),
    args: summariseArgs(args),
    status: "error",
    error: String(error).slice(0, 200),
    client: String(client ?? "").slice(0, 80),
    at: new Date(),
    expireAt: expiry(),
  }).catch((err) => console.error("Couldn't write an MCP audit entry:", err.message));
}
