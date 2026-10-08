import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { escapeHtml, shorten, previewPage, MAX_DESCRIPTION } from "../routes/preview.routes.js";

let signups = 0;
async function signup(app, name, over = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.110.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name, ...over });
  return { agent, user: res.body.user };
}

describe("making text safe for a page", () => {
  it("nothing in it can be read as markup", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'q'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;");
  });
  it("shortening counts whole characters and marks the cut", () => {
    expect(shorten("short", 10)).toBe("short");
    expect(shorten("abcdefghij", 5)).toBe("abcd…");
    expect([...shorten("😀".repeat(20), 10)]).toHaveLength(10);
  });
  it("the page escapes everything put into it and only asks search engines in when told to", () => {
    const html = previewPage({ title: `"><script>x</script>`, description: "<b>hi</b>", image: `https://x.test/a.png"onerror="y`, url: "https://s.test/u/a", target: "https://s.test/u/a", index: false });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(`"onerror="`);
    expect(html).toContain('content="noindex,nofollow"');
    expect(previewPage({ title: "t", description: "d", url: "u", target: "u", index: true })).toContain('content="index,follow"');
  });
});

describe("link previews and the sitemap", () => {
  let app, User;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ User } = await import("../models/User.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const preview = (name) => request(app).get(`/api/preview/profile/${name}`).set("x-vercel-forwarded-for", "203.0.113.9");

  it("a public profile's preview has its name, bio and picture, and sends people on to the real profile", async () => {
    const alice = await signup(app, "alice");
    await alice.agent.patch("/api/profiles/me").send({ bio: "I make <b>pots</b> & jugs", avatarUrl: "https://img.example.com/a.png" });
    const res = await preview("Alice");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'"); // the page loads nothing (and isn't told to upgrade the way on to the profile to https)
    expect(res.text).toContain('property="og:title" content="alice (@alice) · CreativesSelect"');
    expect(res.text).toContain("I make &lt;b&gt;pots&lt;/b&gt; &amp; jugs");
    expect(res.text).toContain('property="og:image" content="https://img.example.com/a.png"');
    expect(res.text).toMatch(/http-equiv="refresh" content="0;url=[^"]*\/u\/alice"/);
  });

  it("without a bio it says in the person's language what they are on the site for", async () => {
    const maria = await signup(app, "maria");
    await maria.agent.patch("/api/profiles/me").send({ language: "es", tags: ["ceramica"], bio: "" });
    const res = await preview("maria");
    expect(res.text).toContain("está en CreativesSelect");
    expect(res.text).toContain('<html lang="es">');
  });

  it("is kept out of search engines unless the owner switched listing on", async () => {
    const alice = await signup(app, "alice");
    let res = await preview("alice");
    expect(res.text).toContain("noindex,nofollow");
    expect(res.headers["x-robots-tag"]).toMatch(/noindex/);
    await alice.agent.patch("/api/profiles/me").send({ listInSearchEngines: true });
    res = await preview("alice");
    expect(res.text).toContain("index,follow");
    expect(res.text).not.toContain("noindex");
    expect(res.headers["x-robots-tag"]).toBe("all");
  });

  it("a picture that isn't https is not used", async () => {
    const alice = await signup(app, "alice");
    await User.updateOne({ username: "alice" }, { avatarUrl: "http://insecure.example.com/a.png" });
    const res = await preview("alice");
    expect(res.text).not.toContain("insecure.example.com");
    expect(res.text).toContain("og-image.png");
    void alice;
  });

  it("private, suspended and missing profiles all get the same bare page", async () => {
    const hidden = await signup(app, "hidden");
    await hidden.agent.patch("/api/profiles/me").send({ isPrivate: true, bio: "secret words" });
    await signup(app, "banned", { bio: "banned words" });
    await User.updateOne({ username: "banned" }, { suspendedAt: new Date(), bio: "banned words" });
    const pages = [];
    for (const name of ["hidden", "banned", "nobody"]) {
      const res = await preview(name);
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/secret words|banned words|@hidden|@banned/);
      expect(res.text).toContain("noindex");
      pages.push(res.text.replace(/\/u\/\w+/g, "/u/x"));
    }
    expect(new Set(pages).size).toBe(1);
  });

  it("a name that couldn't be a username gets the home page's preview", async () => {
    const res = await request(app).get("/api/preview/profile/not%20a%20name!").set("x-vercel-forwarded-for", "203.0.113.10");
    expect(res.status).toBe(200);
    expect(res.text).toContain('property="og:title" content="CreativesSelect"');
  });

  it("the description is never longer than the limit", async () => {
    const alice = await signup(app, "alice");
    await User.updateOne({ username: "alice" }, { bio: "word ".repeat(200) });
    const res = await preview("alice");
    const description = res.text.match(/property="og:description" content="([^"]*)"/)[1];
    expect([...description].length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    void alice;
  });

  it("the sitemap lists only public profiles whose owners asked to be listed", async () => {
    const listed = await signup(app, "listed");
    await listed.agent.patch("/api/profiles/me").send({ listInSearchEngines: true });
    await signup(app, "quiet");
    const priv = await signup(app, "private1");
    await priv.agent.patch("/api/profiles/me").send({ listInSearchEngines: true });
    await priv.agent.patch("/api/profiles/me").send({ isPrivate: true });
    const res = await request(app).get("/api/preview/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/xml/);
    expect(res.text).toContain("/u/listed</loc>");
    expect(res.text).not.toContain("/u/quiet");
    expect(res.text).not.toContain("/u/private1");
  });

  it("listing in search engines must be true or false", async () => {
    const alice = await signup(app, "alice");
    const res = await alice.agent.patch("/api/profiles/me").send({ listInSearchEngines: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("listInSearchEngines must be true or false");
  });

  it("a public profile's blog list can be read without signing in; a private one's cannot", async () => {
    const alice = await signup(app, "alice");
    expect((await request(app).get("/api/blog/user/alice")).status).toBe(200);
    await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
    expect((await request(app).get("/api/blog/user/alice")).status).toBe(403);
  });
});
