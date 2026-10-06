import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { COLOR_KEYS, FONTS, STYLE_CHOICES, THEME_KEYS, applyThemeChange, checkTheme } from "../utils/profileStyle.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${80 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user, name };
}

describe("what a profile's style can be", () => {
  it("is a choice from fixed lists, a plain colour, or one of the listed fonts", () => {
    expect(Object.keys(STYLE_CHOICES)).toEqual(["cardStyle", "corners", "density", "headings", "avatarShape", "width", "layoutStyle"]);
    expect(STYLE_CHOICES.cardStyle).toEqual(["solid", "outline", "glass", "flat"]);
    expect(STYLE_CHOICES.corners).toEqual(["square", "rounded", "soft"]);
    expect(STYLE_CHOICES.density).toEqual(["compact", "comfortable", "roomy"]);
    expect(STYLE_CHOICES.headings).toEqual(["caps", "plain", "serif"]);
    expect(STYLE_CHOICES.avatarShape).toEqual(["circle", "rounded", "square"]);
    expect(STYLE_CHOICES.width).toEqual(["narrow", "standard", "wide"]);
    expect(THEME_KEYS).toEqual(expect.arrayContaining([...COLOR_KEYS, "fontFamily", ...Object.keys(STYLE_CHOICES)]));
    expect(FONTS).toHaveLength(10);
    expect(new Set(FONTS).size).toBe(10);
  });

  it("keeps the four fonts the editor always offered, exactly as saved before", () => {
    for (const old of ["system-ui, sans-serif", "Georgia, serif", "'Courier New', monospace", "'Trebuchet MS', sans-serif"]) expect(checkTheme({ fontFamily: old }).value).toEqual({ fontFamily: old });
  });

  it("only uses fonts already on people's devices, so nothing is loaded from anywhere else", () => {
    for (const font of FONTS) expect(font).not.toMatch(/url\(|@import|https?:|\/\/|[;{}<>]/i);
  });

  it("accepts every choice on every list", () => {
    for (const [key, list] of Object.entries(STYLE_CHOICES)) for (const choice of list) expect(checkTheme({ [key]: choice }), `${key}=${choice}`).toEqual({ value: { [key]: choice } });
    for (const font of FONTS) expect(checkTheme({ fontFamily: font }).value).toEqual({ fontFamily: font });
  });

  it("takes a colour only as six hex digits, and keeps it lower case", () => {
    expect(checkTheme({ bgColor: "#1A2B3C", textColor: "#ffffff", accentColor: "#00FF7f" }).value).toEqual({ bgColor: "#1a2b3c", textColor: "#ffffff", accentColor: "#00ff7f" });
    for (const bad of ["red", "#fff", "#12345", "#1234567", "1a2b3c", "rgb(1,2,3)", "hsl(0,0%,0%)", "#12345g", "#1a2b3c; background:url(//evil)", "url(x)", "var(--x)", "#1a2b3c ", 5, true, {}, ["#1a2b3c"]]) {
      expect(checkTheme({ bgColor: bad }).error, JSON.stringify(bad)).toMatch(/bgColor must be a colour/);
    }
  });

  it("refuses a font that isn't one of the choices, and anything that isn't on a list", () => {
    for (const bad of ["Arial", "x; background:url(//evil)", "Georgia", "inherit", 5, {}, "system-ui, sans-serif; color:red"]) expect(checkTheme({ fontFamily: bad }).error, JSON.stringify(bad)).toMatch(/isn't one of the choices/);
    for (const [key, bad] of [["cardStyle", "neon"], ["corners", "round"], ["density", "tight"], ["headings", "huge"], ["avatarShape", "star"], ["width", "full"], ["layoutStyle", "masonry"], ["cardStyle", "SOLID"], ["corners", 1], ["width", ["wide"]]]) {
      expect(checkTheme({ [key]: bad }).error, `${key}=${JSON.stringify(bad)}`).toMatch(new RegExp(`${key} must be one of`));
    }
  });

  it("refuses a setting that doesn't exist, rather than keeping it, and anything that isn't an object", () => {
    for (const bad of [{ customCss: "body{display:none}" }, { css: "x" }, { background: "#fff" }, { __proto__x: 1 }, { constructor: "x" }, { bgColor: "#ffffff", extra: 1 }]) expect(checkTheme(bad).error, JSON.stringify(bad)).toMatch(/Unknown theme setting/);
    for (const bad of [undefined, null, "x", 5, [], [{ cardStyle: "solid" }]]) expect(checkTheme(bad).error).toBe("theme must be an object");
  });

  it("takes null or an empty string to mean 'back to the default'", () => {
    expect(checkTheme({ cardStyle: null, bgColor: "", fontFamily: null }).value).toEqual({ cardStyle: null, bgColor: null, fontFamily: null });
    expect(checkTheme({}).value).toEqual({});
  });

  it("puts a change into a theme, and takes out what was set to null", () => {
    const before = { bgColor: "#111111", cardStyle: "glass", width: "wide" };
    expect(applyThemeChange(before, { cardStyle: null, corners: "square", bgColor: "#222222" })).toEqual({ bgColor: "#222222", width: "wide", corners: "square" });
    expect(before).toEqual({ bgColor: "#111111", cardStyle: "glass", width: "wide" }); // the old one is left alone
    expect(applyThemeChange(undefined, { width: "narrow" })).toEqual({ width: "narrow" });
  });
});

describe("saving a profile's style", () => {
  let app, M;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = { User: (await import("../models/User.js")).User };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const save = (who, theme, extra = {}) => who.agent.patch("/api/profiles/me").send({ theme, ...extra });
  const themeOf = async (viewer, username) => (await viewer.agent.get(`/api/profiles/${username}`)).body.user?.theme;

  it("saves each setting, and everyone who can see the profile sees them", async () => {
    const me = await signup(app, "mimi");
    const viewer = await signup(app, "viewer");
    const style = { bgColor: "#102030", textColor: "#f0f0f0", accentColor: "#ff00aa", fontFamily: FONTS[7], cardStyle: "glass", corners: "soft", density: "roomy", headings: "serif", avatarShape: "rounded", width: "wide" };
    const res = await save(me, style);
    expect(res.status).toBe(200);
    expect(res.body.user.theme).toMatchObject(style);
    expect(await themeOf(viewer, "mimi")).toMatchObject(style);
    expect((await M.User.findById(me.user.id)).theme.cardStyle).toBe("glass");
  });

  it("changes only the settings it is sent, and takes one away with null", async () => {
    const me = await signup(app, "mimi");
    await save(me, { cardStyle: "outline", corners: "square", width: "narrow" });
    await save(me, { corners: "soft" });
    expect(await themeOf(me, "mimi")).toMatchObject({ cardStyle: "outline", corners: "soft", width: "narrow" });
    await save(me, { cardStyle: null, width: "" });
    const theme = await themeOf(me, "mimi");
    expect(theme).toMatchObject({ corners: "soft" });
    expect(theme.cardStyle ?? null).toBeNull();
    expect(theme.width ?? null).toBeNull();
  });

  it("accepts the settings a profile was saved with before there were any new ones", async () => {
    const me = await signup(app, "mimi");
    const old = { bgColor: "#12121a", textColor: "#f5f5f7", accentColor: "#8b5cf6", fontFamily: "system-ui, sans-serif", layoutStyle: "grid" };
    expect((await save(me, old)).status).toBe(200);
    expect((await save(me, { ...old, cardStyle: "flat" })).status).toBe(200);
  });

  it("refuses a bad setting with the reason, and changes nothing at all, not even the rest of the same request", async () => {
    const me = await signup(app, "mimi");
    await save(me, { cardStyle: "outline" }, { bio: "Before" });
    for (const bad of [{ cardStyle: "neon" }, { bgColor: "red" }, { fontFamily: "Arial" }, { customCss: "x" }, [], "x", { corners: "soft", width: "full" }]) {
      const res = await save(me, bad, { bio: "After" });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error).toBeTruthy();
    }
    const row = await M.User.findById(me.user.id);
    expect(row.bio).toBe("Before");
    expect(row.theme.cardStyle).toBe("outline");
    expect(row.theme.corners).toBeUndefined();
  });

  it("is only the owner's to change, and only when signed in", async () => {
    const me = await signup(app, "mimi");
    const other = await signup(app, "other");
    await save(me, { cardStyle: "glass" });
    await save(other, { cardStyle: "flat" });
    expect(await themeOf(other, "mimi")).toMatchObject({ cardStyle: "glass" });
    expect((await request(app).patch("/api/profiles/me").send({ theme: { cardStyle: "flat" } })).status).toBe(401);
  });

  it("is part of what a private profile keeps back from strangers, and what a friend sees", async () => {
    const me = await signup(app, "mimi");
    const stranger = await signup(app, "stranger");
    const friend = await signup(app, "friend");
    await save(me, { cardStyle: "glass", bgColor: "#102030" });
    await me.agent.patch("/api/profiles/me").send({ isPrivate: true });
    const sent = await friend.agent.post("/api/friends/request/mimi");
    await me.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
    const asStranger = await stranger.agent.get("/api/profiles/mimi");
    expect(JSON.stringify(asStranger.body)).not.toMatch(/glass|#102030/);
    expect((await themeOf(friend, "mimi")).cardStyle).toBe("glass");
    const found = (await stranger.agent.get("/api/search?q=mimi")).body.results[0];
    expect(found.theme).toBeUndefined();
  });

  it("does not let a setting save anything but what it names (no stray fields reach the profile)", async () => {
    const me = await signup(app, "mimi");
    const res = await me.agent.patch("/api/profiles/me").send({ theme: { cardStyle: "flat" }, isAdmin: true, csVerifiedByAdmin: true, "theme.bgColor": "red" });
    expect(res.status).toBe(200);
    const row = await M.User.findById(me.user.id);
    expect(row.csVerifiedByAdmin).toBe(false);
    expect(row.theme.bgColor).toBeUndefined();
  });
});
