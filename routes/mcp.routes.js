import { Router } from "express";
import mongoose from "mongoose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpAuditEntry } from "../models/McpAuditEntry.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { clientIp } from "../utils/clientIp.js";
import { createLimiter } from "../utils/rateLimit.js";
import { SERVER_INFO, TOOLS, auditRejected, buildMcpServer } from "../mcp/server.js";
import { publicSite } from "./preview.routes.js";

// The MCP server, over Streamable HTTP: POST /api/mcp speaks the Model Context Protocol (JSON-RPC), GET /api/mcp says what it is for a person
// who opens the address, and GET /api/mcp/audit is the log of every tool call (administrators only). It keeps no sessions: each request is
// answered on its own, so a server that has just woken up works at once. Cross-site browser requests are already turned away by
// requireTrustedOrigin; programs (which send no Origin) are limited by address.
export const mcpRouter = Router();

const limiter = createLimiter({ name: "mcp", limit: 300, windowMs: 60 * 60 * 1000 });

// The off switch: set MCP_DISABLED=true on the server and every tool address answers 503 at once (the audit log stays readable), with no
// redeploy and nothing else on the API affected. Remove it to switch the server back on.
mcpRouter.use((req, res, next) => {
  if (process.env.MCP_DISABLED !== "true" || req.path.startsWith("/audit")) return next();
  res.set("Retry-After", "3600");
  res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "The MCP server is switched off" }, id: null });
});
const PAGE = 50;

mcpRouter.get("/", (req, res) => {
  // a program asking for the server's event stream: this server has none
  if ((req.get("accept") ?? "").includes("text/event-stream")) {
    res.set("Allow", "POST");
    return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "This server answers POST requests" }, id: null });
  }
  res.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    protocol: "Model Context Protocol, Streamable HTTP (stateless, JSON responses)",
    endpoint: `${publicSite()}/api/mcp`,
    about: "Read-only tools over what is public on CreativesSelect, and over the project's own documents, with citations.",
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
    audit: "Every tool call is logged (the tool, what was asked, whether it worked, how long it took); the log is readable by administrators.",
    source: "https://github.com/OttoNyne/first-server",
  });
});

mcpRouter.delete("/", (req, res) => {
  res.set("Allow", "GET, POST");
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "There are no sessions to end" }, id: null });
});

// The audit log, newest first, 50 a page (?before=<entry id>).
mcpRouter.get("/audit", requireAdmin, async (req, res) => {
  const filter = {};
  if (typeof req.query.before === "string" && mongoose.isValidObjectId(req.query.before)) filter._id = { $lt: req.query.before };
  const rows = await McpAuditEntry.find(filter).sort({ _id: -1 }).limit(PAGE + 1).lean();
  const entries = rows.slice(0, PAGE).map((e) => ({
    id: String(e._id),
    requestId: e.requestId,
    at: e.at,
    tool: e.tool,
    args: e.args,
    status: e.status,
    resultCount: e.resultCount,
    sources: e.sources,
    error: e.error || undefined,
    durationMs: e.durationMs,
    client: e.client,
  }));
  res.json({ entries, hasMore: rows.length > PAGE, next: entries.length ? entries[entries.length - 1].id : null });
});

mcpRouter.post("/", async (req, res) => {
  if (!(await limiter.allow(clientIp(req)))) {
    res.set("Retry-After", String(limiter.windowSeconds));
    return res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests — try again later" }, id: null });
  }
  const client = req.get("user-agent") ?? "";
  const { server, calls } = buildMcpServer({ client });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    // a tool call the protocol refused before it ran (an argument of the wrong kind) is in the log too
    const asked = (Array.isArray(req.body) ? req.body : [req.body]).filter((m) => m?.method === "tools/call");
    if (asked.length > calls.count) {
      await auditRejected({ tool: asked[0]?.params?.name, args: asked[0]?.params?.arguments, client, error: "Turned away before it ran: the arguments were not of the kinds the tool takes" });
    }
  } catch (err) {
    console.error("MCP request failed:", err.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
