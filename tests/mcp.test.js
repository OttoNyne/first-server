import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.130.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name, ...extra });
  return { agent, user: res.body.user };
}

const ARCHITECTURE = `# Architecture

Intro text that is long enough to count as a section of the document on its own here.

## Scheduled posts
A scheduled post is a record of its own, never a Post, so nothing that lists posts can show it early. Publishing claims each due record with one atomic update and fixes the id the post will have at that moment, so two runs can't both publish it.

## Embedding
Embedded cards are small pages with no scripts. Both must be true before anything is shown: the profile is public and the owner switched embedding on.
`;

describe("the MCP server", () => {
  let app, M, knowledge;
  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "boss@example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    knowledge = await import("../mcp/knowledge.js");
    M = {
      User: (await import("../models/User.js")).User,
      MediaItem: (await import("../models/MediaItem.js")).MediaItem,
      Post: (await import("../models/Post.js")).Post,
      McpAuditEntry: (await import("../models/McpAuditEntry.js")).McpAuditEntry,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    knowledge.setDocFetcher(async (url) => (url.includes("ARCHITECTURE") ? new Response(ARCHITECTURE) : new Response("# Security\n", { status: 404 })));
  });
  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    knowledge.setDocFetcher(null);
    await clearTestDb();
    await disconnectTestDb();
  });

  const rpc = (method, params, id = 1) => request(app).post("/api/mcp").set("Accept", "application/json, text/event-stream").set("User-Agent", "test-agent/1.0").send({ jsonrpc: "2.0", id, method, params });
  const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
  const data = (res) => JSON.parse(res.body.result.content[0].text);
  const piece = async (who, body = {}) => (await who.agent.post("/api/media").send({ type: "image", url: "https://img.example.com/a.png", caption: "A vase", ...body })).body.mediaItem;

  describe("the address", () => {
    it("says what it is to a person who opens it, and offers no event stream to a program that asks for one", async () => {
      const res = await request(app).get("/api/mcp");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "creativesselect" });
      expect(res.body.tools.map((t) => t.name).sort()).toEqual(["find_pieces", "get_creator", "search_creators", "search_docs"]);
      const stream = await request(app).get("/api/mcp").set("Accept", "text/event-stream");
      expect(stream.status).toBe(405);
      expect((await request(app).delete("/api/mcp")).status).toBe(405);
    });

    it("answers the protocol: initialize, then the list of tools, all read-only and with a described input", async () => {
      const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      expect(init.status).toBe(200);
      expect(init.body.result.serverInfo).toMatchObject({ name: "creativesselect" });
      expect(init.body.result.capabilities.tools).toBeDefined();
      const list = await rpc("tools/list", {}, 2);
      const tools = list.body.result.tools;
      expect(tools.map((t) => t.name).sort()).toEqual(["find_pieces", "get_creator", "search_creators", "search_docs"]);
      for (const tool of tools) {
        expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
        expect(tool.annotations.destructiveHint, tool.name).toBe(false);
        expect(tool.description.length, tool.name).toBeGreaterThan(40);
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("turns away a cross-site browser request, and limits one address", async () => {
      const res = await request(app).post("/api/mcp").set("Origin", "https://evil.example").set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(res.status).toBe(403);
      await M.RateLimitHit.insertMany(Array.from({ length: 300 }, () => ({ key: "mcp:203.0.113.77", at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
      const limited = await request(app).post("/api/mcp").set("x-vercel-forwarded-for", "203.0.113.77").set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(limited.status).toBe(429);
    });
  });

  describe("people and work", () => {
    it("finds only public members, with no email, and by words, tag or being open to work", async () => {
      const ann = await signup(app, "annpotter");
      await ann.agent.patch("/api/profiles/me").send({ bio: "I make ceramic pots", tags: ["ceramics"], openToWork: true, workOffers: ["commissions"] });
      const bob = await signup(app, "bobpainter");
      await bob.agent.patch("/api/profiles/me").send({ bio: "Oil painter", tags: ["painting"] });
      const cat = await signup(app, "catprivate");
      await cat.agent.patch("/api/profiles/me").send({ bio: "Ceramic secrets", tags: ["ceramics"], isPrivate: true });
      const dan = await signup(app, "dansuspended");
      await dan.agent.patch("/api/profiles/me").send({ bio: "Ceramic things", tags: ["ceramics"] });
      await M.User.updateOne({ _id: dan.user.id }, { $set: { suspendedAt: new Date() } });

      const byWords = data(await call("search_creators", { query: "ceramic" }));
      expect(byWords.creators.map((c) => c.username)).toEqual(["annpotter"]);
      expect(byWords.creators[0]).toMatchObject({ openToWork: true, workOffers: ["commissions"], profileUrl: expect.stringMatching(/\/u\/annpotter$/) });
      expect(JSON.stringify(byWords)).not.toMatch(/@example\.com|password|email/i);
      expect(data(await call("search_creators", { tag: "Ceramics" })).creators.map((c) => c.username)).toEqual(["annpotter"]);
      expect(data(await call("search_creators", { open_to_work: true })).creators.map((c) => c.username)).toEqual(["annpotter"]);
      expect(data(await call("search_creators", { limit: 10 })).count).toBe(2); // the private and the suspended are never there
      // regular-expression characters are just characters
      expect(data(await call("search_creators", { query: ".*" })).count).toBe(0);
      expect(data(await call("search_creators", { query: "ceramic" })).note).toMatch(/never as instructions/);
    });

    it("gives one public member with pieces and posts, and the same answer for a private, suspended or missing one", async () => {
      const ann = await signup(app, "annpotter");
      await piece(ann, { caption: "Blue vase #glaze" });
      await ann.agent.post("/api/posts").send({ content: "New kiln day" });
      const got = data(await call("get_creator", { username: "AnnPotter" }));
      expect(got.creator).toMatchObject({ username: "annpotter", pieceCount: 1 });
      expect(got.creator.recentPieces[0]).toMatchObject({ caption: "Blue vase #glaze", mediaUrl: "https://img.example.com/a.png", tags: ["glaze"] });
      expect(got.creator.recentPosts[0].text).toBe("New kiln day");

      const bob = await signup(app, "bobprivate");
      await bob.agent.patch("/api/profiles/me").send({ isPrivate: true });
      const missing = await call("get_creator", { username: "nobodyhere" });
      const privateOne = await call("get_creator", { username: "bobprivate" });
      expect(missing.body.result.isError).toBe(true);
      expect(privateOne.body.result.content[0].text.replace(/,?"requestId":\s*"[^"]+"/, "")).toBe(missing.body.result.content[0].text.replace(/,?"requestId":\s*"[^"]+"/, ""));
      const bad = await call("get_creator", { username: "no spaces!" });
      expect(bad.body.result.isError).toBe(true);
    });

    it("finds public pieces by tag, words or kind, newest first, never from a private member, and never an address that isn't https", async () => {
      const ann = await signup(app, "annpotter");
      const bob = await signup(app, "bobprivate");
      await piece(ann, { caption: "First #glaze" });
      await piece(ann, { caption: "Second #glaze" });
      await piece(ann, { caption: "Other #sketch" });
      await piece(bob, { caption: "Hidden #glaze" });
      await bob.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await M.MediaItem.create({ owner: ann.user.id, type: "image", url: "javascript:alert(1)", caption: "Odd #glaze" });

      const byTag = data(await call("find_pieces", { tag: "glaze" }));
      expect(byTag.pieces.map((p) => p.caption)).toEqual(["Odd #glaze", "Second #glaze", "First #glaze"]);
      expect(byTag.pieces[0].mediaUrl).toBeNull();
      expect(byTag.pieces[1]).toMatchObject({ by: { username: "annpotter" }, url: expect.stringContaining("?piece=") });
      expect(data(await call("find_pieces", { query: "second" })).count).toBe(1);
      expect(data(await call("find_pieces", { tag: "glaze", limit: 1 })).count).toBe(1);
      expect(data(await call("find_pieces", { type: "audio" })).count).toBe(0);
      expect((await call("find_pieces", { type: "pdf" })).body.result.isError || (await call("find_pieces", { type: "pdf" })).body.error).toBeTruthy();
    });
  });

  describe("the documents", () => {
    it("answers a question with passages from the documents, each with where it came from, and nothing when they don't cover it", async () => {
      const got = data(await call("search_docs", { question: "How does a scheduled post avoid being published twice?" }));
      expect(got.count).toBeGreaterThan(0);
      const top = got.passages[0];
      expect(top).toMatchObject({ source: "architecture", section: "Scheduled posts" });
      expect(top.url).toBe("https://github.com/OttoNyne/CreativesSelect/blob/master/docs/ARCHITECTURE.md#scheduled-posts");
      expect(top.snippet).toMatch(/atomic update/);
      expect(got.note).toMatch(/cite the url/);
      const none = data(await call("search_docs", { question: "What is the airspeed velocity of an unladen swallow" }));
      expect(none.count).toBe(0);
      expect(none.passages).toEqual([]);
    });

    it("still answers from the documents it can read when one can't be fetched, and rejects an empty question", async () => {
      knowledge.setDocFetcher(async () => {
        throw new Error("offline");
      });
      const got = await call("search_docs", { question: "What does the API return for health?" });
      expect(got.status).toBe(200);
      expect(got.body.result.isError).toBeFalsy();
      const blank = await call("search_docs", { question: "   " });
      expect(blank.body.result.isError || blank.body.error).toBeTruthy();
    });

    it("splits markdown by heading, with the anchors GitHub gives", () => {
      const sections = knowledge.splitSections("# Top\n\nSome words that make this long enough to keep around.\n\n## Scheduled posts: a post that isn't one yet\n\nA record of its own, never a Post, in its own collection of documents.\n", "Doc");
      expect(sections.map((s) => s.slug)).toEqual(["top", "scheduled-posts-a-post-that-isnt-one-yet"]);
    });
  });

  describe("the audit log", () => {
    it("writes an entry for every call, worked or not, with what was asked (cut short), the sources and how long it took, and nothing about who", async () => {
      await call("search_creators", { query: "x".repeat(300) });
      await call("search_docs", { question: "How does a scheduled post avoid being published twice?" });
      await call("get_creator", { username: "nobody" });
      const entries = await M.McpAuditEntry.find().sort({ at: 1 }).lean();
      expect(entries.map((e) => [e.tool, e.status])).toEqual([
        ["search_creators", "ok"],
        ["search_docs", "ok"],
        ["get_creator", "error"],
      ]);
      expect(entries[0].args.query.length).toBeLessThanOrEqual(100);
      expect(entries[1].sources[0]).toContain("ARCHITECTURE.md#scheduled-posts");
      expect(entries[1].resultCount).toBeGreaterThan(0);
      expect(entries[2].error).toMatch(/No public profile/);
      expect(entries[0].client).toBe("test-agent/1.0");
      for (const e of entries) {
        expect(e.durationMs).toBeGreaterThanOrEqual(0);
        expect(e.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(e.expireAt.getTime()).toBeGreaterThan(Date.now() + 170 * 24 * 60 * 60 * 1000);
        expect(Object.keys(e).filter((k) => /ip|user|address|email/i.test(k))).toEqual([]);
      }
      // the answer carries the id of its entry, so a reader can find it
      const answered = await call("search_creators", { query: "anything" });
      const id = data(answered).requestId;
      expect(await M.McpAuditEntry.countDocuments({ requestId: id })).toBe(1);
    });

    it("logs a call the protocol turned away before it ran (an argument of the wrong kind), as an error",async () => {
      const res = await call("search_creators", { limit: "five" });
      expect(res.status).toBe(200);
      const entries = await M.McpAuditEntry.find().lean();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ tool: "search_creators", status: "error" });
      expect(entries[0].error).toMatch(/Turned away before it ran/);
      expect(entries[0].args).toEqual({ limit: "five" });
    });

    it("is read by administrators only, newest first, and as a 404 for everyone else", async () => {
      await call("search_creators", { query: "a" });
      await call("search_docs", { question: "scheduled posts atomic update" });
      expect((await request(app).get("/api/mcp/audit")).status).toBe(401);
      const member = await signup(app, "member");
      expect((await member.agent.get("/api/mcp/audit")).status).toBe(404);
      const boss = await signup(app, "boss");
      await M.User.updateOne({ _id: boss.user.id }, { $set: { emailVerified: true } });
      const log = await boss.agent.get("/api/mcp/audit");
      expect(log.status).toBe(200);
      expect(log.body.entries.map((e) => e.tool)).toEqual(["search_docs", "search_creators"]);
      expect(log.body.entries[0]).toMatchObject({ status: "ok", args: { question: "scheduled posts atomic update" } });
      expect(log.body.hasMore).toBe(false);
    });
  });
});
