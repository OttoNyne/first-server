import mongoose from "mongoose";

// One call to one tool of the MCP server (see mcp/server.js): which tool, what was asked (each text value cut short), whether it worked, how
// many results came back, the documents an answer was grounded in, and how long it took. It never holds an address or a name for who asked,
// only the program's own label (its User-Agent, cut short). Only administrators can read these (GET /api/mcp/audit), and they go by
// themselves after 180 days.
const mcpAuditEntrySchema = new mongoose.Schema({
  requestId: { type: String, required: true },
  tool: { type: String, required: true },
  args: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ["ok", "error"], required: true },
  resultCount: { type: Number, default: 0 },
  // the places an answer came from: a document and section of the project's own writing, as a link
  sources: { type: [String], default: [] },
  error: { type: String, default: "", maxlength: 200 },
  durationMs: { type: Number, default: 0 },
  client: { type: String, default: "", maxlength: 80 },
  at: { type: Date, default: Date.now },
  expireAt: { type: Date, required: true, expires: 0 },
});

mcpAuditEntrySchema.index({ at: -1 });

export const McpAuditEntry = mongoose.model("McpAuditEntry", mcpAuditEntrySchema);
