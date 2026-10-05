import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { SECTION_KEYS, checkHidden, checkOrder, cleanHidden, completeOrder } from "../utils/profileSections.js";

let signups = 0;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.103.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  if (extra.private) await agent.patch("/api/profiles/me").send({ isPrivate: true });
  return { agent, user: res.body.user };
}

describe("section helpers", () => {
  it("completes an order: known sections once each, then whatever is missing in the usual order", () => {
    expect(completeOrder(undefined)).toEqual(SECTION_KEYS);
    expect(completeOrder([])).toEqual(SECTION_KEYS);
    expect(completeOrder(["blog", "music"])).toEqual(["blog", "music", "about", "friends", "portfolio", "testimonials"]);
    expect(completeOrder(["music", "nonsense", "music", 7, null, "friends"])).toEqual(["music", "friends", "about", "portfolio", "blog", "testimonials"]);
  });
  it("cleans a hidden list", () => {
    expect(cleanHidden(undefined)).toEqual([]);
    expect(cleanHidden(["blog", "blog", "x", 3])).toEqual(["blog"]);
  });
  it("accepts an order only if it is every section exactly once", () => {
    const reversed = [...SECTION_KEYS].reverse();
    expect(checkOrder(reversed)).toEqual({ value: reversed });
    for (const bad of [undefined, "blog", [], SECTION_KEYS.slice(1), [...SECTION_KEYS, "blog"], [...SECTION_KEYS.slice(1), "blog"], [...SECTION_KEYS.slice(1), "nope"], [...SECTION_KEYS.slice(1), 5], { 0: "blog" }]) {
      expect(checkOrder(bad).error, JSON.stringify(bad)).toBeTruthy();
    }
  });
  it("accepts a hidden list of known sections, each once, including none", () => {
    expect(checkHidden([])).toEqual({ value: [] });
    expect(checkHidden(["blog", "music"])).toEqual({ value: ["blog", "music"] });
    for (const bad of [undefined, "blog", ["blog", "blog"], ["nope"], [1], null]) expect(checkHidden(bad).error, JSON.stringify(bad)).toBeTruthy();
  });
});

describe("rearranging and hiding profile sections", () => {
  let app;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  it("starts in the usual order with nothing hidden, for everyone", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bobby");
    expect(alice.user.sectionOrder).toEqual(SECTION_KEYS);
    const seen = (await bob.agent.get("/api/profiles/alice")).body.user;
    expect(seen.sectionOrder).toEqual(SECTION_KEYS);
    expect(seen.hiddenSections).toEqual([]);
  });

  it("saves a new order and hidden sections, and everyone who looks sees them", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bobby");
    const order = ["blog", "portfolio", "testimonials", "music", "friends", "about"];
    const res = await alice.agent.patch("/api/profiles/me").send({ sectionOrder: order, hiddenSections: ["music"] });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ sectionOrder: order, hiddenSections: ["music"] });
    const seen = (await bob.agent.get("/api/profiles/alice")).body.user;
    expect(seen).toMatchObject({ sectionOrder: order, hiddenSections: ["music"] });
    expect((await request(app).get("/api/profiles/alice")).body.user).toMatchObject({ sectionOrder: order, hiddenSections: ["music"] });
  });

  it("can change one without the other, and show everything again", async () => {
    const alice = await signup(app, "alice");
    await alice.agent.patch("/api/profiles/me").send({ hiddenSections: ["blog", "music"] });
    await alice.agent.patch("/api/profiles/me").send({ sectionOrder: [...SECTION_KEYS].reverse() });
    let me = (await alice.agent.get("/api/profiles/alice")).body.user;
    expect(me.hiddenSections).toEqual(["blog", "music"]);
    expect(me.sectionOrder).toEqual([...SECTION_KEYS].reverse());
    await alice.agent.patch("/api/profiles/me").send({ hiddenSections: [] });
    me = (await alice.agent.get("/api/profiles/alice")).body.user;
    expect(me.hiddenSections).toEqual([]);
  });

  it("refuses an order that isn't every section once, or a hidden list with unknown names, and changes nothing", async () => {
    const alice = await signup(app, "alice");
    const order = ["blog", "portfolio", "testimonials", "music", "friends", "about"];
    await alice.agent.patch("/api/profiles/me").send({ sectionOrder: order, hiddenSections: ["blog"] });
    for (const body of [{ sectionOrder: ["blog"] }, { sectionOrder: "blog" }, { sectionOrder: [...order.slice(1), "music"] }, { sectionOrder: [...order.slice(1), "nope"] }, { hiddenSections: ["nope"] }, { hiddenSections: ["blog", "blog"] }, { hiddenSections: "blog" }, { hiddenSections: [{ $ne: 1 }] }]) {
      const res = await alice.agent.patch("/api/profiles/me").send({ bio: "should not be saved", ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const me = (await alice.agent.get("/api/profiles/alice")).body.user;
    expect(me).toMatchObject({ sectionOrder: order, hiddenSections: ["blog"] });
    expect(me.bio).not.toBe("should not be saved");
  });

  it("can't be changed by anyone but the owner", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bobby");
    await bob.agent.patch("/api/profiles/me").send({ sectionOrder: [...SECTION_KEYS].reverse() });
    expect((await alice.agent.get("/api/profiles/alice")).body.user.sectionOrder).toEqual(SECTION_KEYS);
    expect((await request(app).patch("/api/profiles/me").send({ hiddenSections: ["blog"] })).status).toBe(401);
  });

  it("is hidden along with the rest of a private profile", async () => {
    const alice = await signup(app, "alice", { private: true });
    const cara = await signup(app, "carah");
    await alice.agent.patch("/api/profiles/me").send({ hiddenSections: ["blog"] });
    const res = await cara.agent.get("/api/profiles/alice");
    expect(res.status).toBe(403);
  });

  it("copes with a profile saved before sections existed", async () => {
    const alice = await signup(app, "alice");
    const { User } = await import("../models/User.js");
    await User.collection.updateOne({ username: "alice" }, { $unset: { sectionOrder: "", hiddenSections: "" } });
    const me = (await alice.agent.get("/api/profiles/alice")).body.user;
    expect(me.sectionOrder).toEqual(SECTION_KEYS);
    expect(me.hiddenSections).toEqual([]);
  });

  it("fills in a section added later: a saved order from before it is completed", async () => {
    const alice = await signup(app, "alice");
    const { User } = await import("../models/User.js");
    await User.collection.updateOne({ username: "alice" }, { $set: { sectionOrder: ["music", "friends"] } });
    expect((await alice.agent.get("/api/profiles/alice")).body.user.sectionOrder).toEqual(["music", "friends", "about", "portfolio", "blog", "testimonials"]);
  });
});
