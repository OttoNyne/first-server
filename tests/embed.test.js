import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.128.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name, ...extra });
  return { agent, user: res.body.user };
}

describe("embedded pieces and profile cards", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
      MediaItem: (await import("../models/MediaItem.js")).MediaItem,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const piece = async (who, body = {}) => (await who.agent.post("/api/media").send({ type: "image", url: "https://img.example.com/vase.png", caption: "A glazed vase", ...body })).body.mediaItem;
  // pieces the API itself would refuse (or can only be made by an upload), put straight into the database
  const raw = async (who, fields) => ({ id: String((await M.MediaItem.create({ owner: who.user.id, type: "image", ...fields }))._id) });
  const allow = (who, on = true) => who.agent.patch("/api/profiles/me").send({ allowEmbeds: on });
  const card = (path) => request(app).get(`/api/embed/${path}`);

  describe("the setting", () => {
    it("is off to begin with, changed only by its owner, and must be true or false", async () => {
      const ann = await signup(app, "ann");
      expect((await M.User.findById(ann.user.id)).allowEmbeds).toBe(false);
      expect((await ann.agent.patch("/api/profiles/me").send({ allowEmbeds: "yes" })).status).toBe(400);
      const on = await allow(ann);
      expect(on.status).toBe(200);
      expect(on.body.user.allowEmbeds).toBe(true);
      expect((await M.User.findById(ann.user.id)).allowEmbeds).toBe(true);
    });
  });

  describe("a piece", () => {
    it("shows the picture, its words and its maker to anyone, in a page that may be framed anywhere and loads nothing else", async () => {
      const ann = await signup(app, "ann");
      await allow(ann);
      const vase = await piece(ann);
      const res = await card(`piece/${vase.id}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text).toContain('<img src="https://img.example.com/vase.png" alt="A glazed vase">');
      expect(res.text).toContain("A glazed vase");
      expect(res.text).toContain("by ann");
      expect(res.text).toContain(`/u/ann?piece=${vase.id}#portfolio`);
      expect(res.text).toContain('rel="noopener noreferrer"');
      expect(res.text).not.toContain("<script");
      // anyone may frame it, and it loads only pictures and media
      expect(res.headers["x-frame-options"]).toBeUndefined();
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors *");
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
    });

    it("keeps the rest of the API unframeable", async () => {
      const res = await request(app).get("/api/health");
      expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    });

    it("is the same bare page when it isn't there, isn't allowed, or its owner is private or suspended", async () => {
      const ann = await signup(app, "ann");
      const vase = await piece(ann);
      const bare = await card(`piece/${vase.id}`); // embedding not switched on
      expect(bare.status).toBe(404);
      expect(bare.text).not.toContain("A glazed vase");
      const missing = await card("piece/6ac93c2f67d5dc8c7fdb7931");
      const invalid = await card("piece/nope");
      expect(missing.status).toBe(404);
      expect(invalid.status).toBe(404);
      expect(missing.text).toBe(bare.text);
      expect(invalid.text).toBe(bare.text);
      await allow(ann);
      expect((await card(`piece/${vase.id}`)).status).toBe(200);
      await M.User.updateOne({ _id: ann.user.id }, { $set: { isPrivate: true } });
      expect((await card(`piece/${vase.id}`)).text).toBe(bare.text);
      await M.User.updateOne({ _id: ann.user.id }, { $set: { isPrivate: false, suspendedAt: new Date() } });
      expect((await card(`piece/${vase.id}`)).text).toBe(bare.text);
      await M.User.updateOne({ _id: ann.user.id }, { $set: { suspendedAt: null } });
      await allow(ann, false);
      expect((await card(`piece/${vase.id}`)).text).toBe(bare.text);
    });

    it("puts nothing a person wrote into the page as markup, and never an address that isn't https or a small inline picture", async () => {
      const ann = await signup(app, "ann");
      await allow(ann);
      const sneaky = await piece(ann, { caption: '"><script>alert(1)</script> & <b>x</b>', url: "https://img.example.com/a.png" });
      const html = (await card(`piece/${sneaky.id}`)).text;
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("<b>x</b>");
      expect(html).toContain("&lt;script&gt;");
      const javascript = await raw(ann, { url: "javascript:alert(1)", caption: "js" });
      const other = (await card(`piece/${javascript.id}`)).text;
      expect(other).not.toContain("javascript:");
      expect(other).not.toContain("<img");
      expect(other).toContain("js"); // the words and a link to the piece still are
      const quote = await raw(ann, { url: 'https://img.example.com/a.png" onerror="alert(1)', caption: "q" });
      expect((await card(`piece/${quote.id}`)).text).not.toContain("onerror");
      const inline = await piece(ann, { url: "data:image/png;base64,iVBORw0KGgo=", caption: "inline" });
      expect((await card(`piece/${inline.id}`)).text).toContain("data:image/png;base64,iVBORw0KGgo=");
      const svg = await raw(ann, { url: "data:image/svg+xml;base64,PHN2Zz4=", caption: "svg" });
      expect((await card(`piece/${svg.id}`)).text).not.toContain("data:image/svg");
    });

    it("plays an uploaded video or sound and labels a picture made with AI", async () => {
      const ann = await signup(app, "ann");
      await allow(ann);
      const video = await raw(ann, { type: "video", url: "https://img.example.com/clip.mp4", caption: "clip" });
      const sound = await raw(ann, { type: "audio", url: "https://img.example.com/song.mp3", caption: "song" });
      expect((await card(`piece/${video.id}`)).text).toContain('<video controls preload="metadata" src="https://img.example.com/clip.mp4">');
      expect((await card(`piece/${sound.id}`)).text).toContain('<audio controls preload="metadata" src="https://img.example.com/song.mp3">');
      const made = await piece(ann, { isAiImage: true, caption: "robot" });
      expect((await card(`piece/${made.id}`)).text).toContain("AI-generated");
    });

    it("speaks the maker's language", async () => {
      const ann = await signup(app, "ann");
      await allow(ann);
      await M.User.updateOne({ _id: ann.user.id }, { $set: { language: "ar" } });
      const vase = await piece(ann);
      const html = (await card(`piece/${vase.id}`)).text;
      expect(html).toContain('lang="ar" dir="rtl"');
      expect(html).toContain("عرض على CreativesSelect");
    });
  });

  describe("a profile card", () => {
    it("shows the name, bio, what they offer and a few pieces, and links to the profile", async () => {
      const ann = await signup(app, "ann");
      await allow(ann);
      await ann.agent.patch("/api/profiles/me").send({ bio: "I make <b>pots</b>", openToWork: true, workOffers: ["ceramics"], tags: ["clay"] });
      for (const n of ["a", "b", "c", "d"]) await piece(ann, { url: `https://img.example.com/${n}.png`, caption: n });
      const res = await card("profile/ann");
      expect(res.status).toBe(200);
      expect(res.text).toContain("@ann");
      expect(res.text).toContain("I make &lt;b&gt;pots&lt;/b&gt;");
      expect(res.text).toContain("Open to work: ceramics");
      expect(res.text).toContain("#clay");
      expect((res.text.match(/class="thumbs"/g) ?? []).length).toBe(1);
      expect((res.text.match(/<a href="[^"]*\?piece=/g) ?? []).length).toBe(3); // the three newest
      expect(res.text).toContain("d.png");
      expect(res.text).not.toContain("a.png");
      expect(res.text).toContain("/u/ann");
      expect(res.headers["x-frame-options"]).toBeUndefined();
    });

    it("is the same bare page for a missing, not-allowed, private or suspended profile", async () => {
      const ann = await signup(app, "ann");
      const bare = await card("profile/nobody-here");
      expect(bare.status).toBe(404);
      expect((await card("profile/ann")).text).toBe(bare.text); // not allowed yet
      await allow(ann);
      expect((await card("profile/ann")).status).toBe(200);
      await M.User.updateOne({ _id: ann.user.id }, { $set: { isPrivate: true } });
      expect((await card("profile/ann")).text).toBe(bare.text);
      await M.User.updateOne({ _id: ann.user.id }, { $set: { isPrivate: false, suspendedAt: new Date() } });
      expect((await card("profile/ann")).text).toBe(bare.text);
      expect((await card("profile/%3Cscript%3E")).text).toBe(bare.text);
    });
  });

  it("limits how often one address can ask", async () => {
    const ann = await signup(app, "ann");
    await allow(ann);
    const vase = await piece(ann);
    const res = await request(app).get(`/api/embed/piece/${vase.id}`).set("x-vercel-forwarded-for", "203.0.113.9");
    await M.RateLimitHit.insertMany(Array.from({ length: 600 }, () => ({ key: "embed:203.0.113.9", at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
    const limited = await request(app).get(`/api/embed/piece/${vase.id}`).set("x-vercel-forwarded-for", "203.0.113.9");
    expect(res.status).toBe(200);
    expect(limited.status).toBe(429);
  });
});
