import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.128.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name.toUpperCase() });
  return { agent, user: res.body.user };
}

describe("artist spotlights on the main screen", () => {
  let app, M;
  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "boss@example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      Spotlight: (await import("../models/Spotlight.js")).Spotlight,
      MediaItem: (await import("../models/MediaItem.js")).MediaItem,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    await clearTestDb();
    await disconnectTestDb();
  });

  async function boss() {
    const b = await signup(app, "boss");
    await M.User.updateOne({ _id: b.user.id }, { $set: { emailVerified: true } });
    return b;
  }
  const piece = async (who, name, extra = {}) => (await who.agent.post("/api/media").send({ type: "image", url: `https://img.example.com/${name}.png`, caption: name, ...extra })).body.mediaItem;
  const put = (admin, slot, body) => admin.agent.put(`/api/admin/spotlights/${slot}`).send(body);
  const publicList = async () => (await request(app).get("/api/spotlights")).body.spotlights;

  describe("what everyone sees", () => {
    it("is open to anyone, signed in or not, and empty until an administrator chooses someone", async () => {
      const res = await request(app).get("/api/spotlights");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ spotlights: [] });
      expect(res.headers["cache-control"]).toBe("public, max-age=60");
    });

    it("shows the two people in slot order, with public facts only", async () => {
      const admin = await boss();
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      await ann.agent.patch("/api/profiles/me").send({ headline: "Illustrator", tags: ["painter", "muralist", "street art", "ceramics", "poster"], bio: "private-ish bio" });
      await piece(ann, "vase");
      await put(admin, 2, { username: "ann", note: "  Her murals   are everywhere " });
      await put(admin, 1, { username: "ben" });
      const list = await publicList();
      expect(list.map((s) => s.slot)).toEqual([1, 2]);
      expect(list[0].user).toMatchObject({ username: "ben", displayName: "BEN", headline: "" });
      expect(list[1]).toMatchObject({ slot: 2, note: "Her murals are everywhere", user: { username: "ann", displayName: "ANN", headline: "Illustrator", tags: ["painter", "muralist", "street art"] } });
      expect(list[1].piece).toMatchObject({ url: "https://img.example.com/vase.png", caption: "vase" });
      expect(list[0].piece).toBeNull();
      const text = JSON.stringify(list);
      for (const secret of ["@example.com", "bio", "passwordHash", "isPrivate", "email"]) expect(text).not.toContain(secret);
      void ben;
    });

    it("shows the picture the administrator chose, else the person's featured piece, else their latest picture", async () => {
      const admin = await boss();
      const ann = await signup(app, "ann");
      const old = await piece(ann, "old");
      const featured = await piece(ann, "featured");
      await piece(ann, "newest");
      // nothing chosen and nothing featured: the latest
      await put(admin, 1, { username: "ann" });
      expect((await publicList())[0].piece.caption).toBe("newest");
      await ann.agent.put(`/api/media/${featured.id}/feature`);
      expect((await publicList())[0].piece.caption).toBe("featured");
      // chosen
      await put(admin, 1, { username: "ann", pieceId: old.id });
      expect((await publicList())[0].piece.caption).toBe("old");
      // the chosen one is taken down: back to the featured one
      await ann.agent.delete(`/api/media/${old.id}`);
      expect((await publicList())[0].piece.caption).toBe("featured");
    });

    it("leaves a slot empty when its person goes private or is suspended, and brings them back when they can be shown again", async () => {
      const admin = await boss();
      const ann = await signup(app, "ann");
      await put(admin, 1, { username: "ann" });
      expect(await publicList()).toHaveLength(1);
      await ann.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect(await publicList()).toEqual([]);
      const seen = (await admin.agent.get("/api/admin/spotlights")).body.slots[0];
      expect(seen).toMatchObject({ slot: 1, empty: false, hidden: "private" });
      await ann.agent.patch("/api/profiles/me").send({ isPrivate: false });
      expect(await publicList()).toHaveLength(1);
      await M.User.updateOne({ _id: ann.user.id }, { $set: { suspendedAt: new Date() } });
      expect(await publicList()).toEqual([]);
      expect((await admin.agent.get("/api/admin/spotlights")).body.slots[0].hidden).toBe("suspended");
    });

    it("loses its slot when the account is deleted", async () => {
      const admin = await boss();
      const ann = await signup(app, "ann");
      await put(admin, 1, { username: "ann" });
      expect((await ann.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await M.Spotlight.countDocuments()).toBe(0);
      expect(await publicList()).toEqual([]);
    });
  });

  describe("choosing them (administrators only)", () => {
    it("answers signed-out visitors with 401 and everyone who isn't an administrator with a plain 404", async () => {
      const ann = await signup(app, "ann");
      expect((await request(app).get("/api/admin/spotlights")).status).toBe(401);
      for (const call of [() => ann.agent.get("/api/admin/spotlights"), () => ann.agent.put("/api/admin/spotlights/1").send({ username: "ann" }), () => ann.agent.delete("/api/admin/spotlights/1")]) {
        expect((await call()).status).toBe(404);
      }
      expect(await M.Spotlight.countDocuments()).toBe(0);
    });

    it("shows both slots, empty or not, and how long a note may be", async () => {
      const admin = await boss();
      await signup(app, "ann");
      await put(admin, 2, { username: "ann", note: "Hello" });
      const res = await admin.agent.get("/api/admin/spotlights");
      expect(res.body.maxNote).toBe(140);
      expect(res.body.slots[0]).toEqual({ slot: 1, empty: true });
      expect(res.body.slots[1]).toMatchObject({ slot: 2, empty: false, note: "Hello", hidden: null, user: { username: "ann" } });
    });

    it("puts someone in a slot, replaces whoever was there, and takes them out", async () => {
      const admin = await boss();
      await signup(app, "ann");
      await signup(app, "ben");
      expect((await put(admin, 1, { username: "ann" })).status).toBe(200);
      expect((await put(admin, 1, { username: "@Ben", note: "New" })).status).toBe(200);
      const list = await publicList();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ slot: 1, note: "New", user: { username: "ben" } });
      expect(await M.Spotlight.countDocuments()).toBe(1);
      expect((await admin.agent.delete("/api/admin/spotlights/1")).status).toBe(204);
      expect(await publicList()).toEqual([]);
      expect((await admin.agent.delete("/api/admin/spotlights/1")).body.error).toBe("That slot is empty");
    });

    it("keeps one person to one slot", async () => {
      const admin = await boss();
      await signup(app, "ann");
      await put(admin, 1, { username: "ann" });
      const res = await put(admin, 2, { username: "ann" });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("That person is already in the other slot");
      // the same person can be updated in their own slot
      expect((await put(admin, 1, { username: "ann", note: "again" })).status).toBe(200);
    });

    it("refuses a slot that doesn't exist, someone who isn't there, a suspended account and a private profile", async () => {
      const admin = await boss();
      const ann = await signup(app, "ann");
      expect((await put(admin, 3, { username: "ann" })).status).toBe(404);
      expect((await put(admin, "x", { username: "ann" })).body.error).toBe("That slot doesn't exist");
      expect((await admin.agent.delete("/api/admin/spotlights/0")).status).toBe(404);
      expect((await put(admin, 1, { username: "nobody" })).body.error).toBe("No one has that username");
      expect((await put(admin, 1, {})).status).toBe(404);
      await ann.agent.patch("/api/profiles/me").send({ isPrivate: true });
      const priv = await put(admin, 1, { username: "ann" });
      expect(priv.status).toBe(400);
      expect(priv.body.error).toBe("That profile is private, so it can't be shown on the main screen");
      await ann.agent.patch("/api/profiles/me").send({ isPrivate: false });
      await M.User.updateOne({ _id: ann.user.id }, { $set: { suspendedAt: new Date() } });
      expect((await put(admin, 1, { username: "ann" })).body.error).toBe("That account is suspended");
      expect(await M.Spotlight.countDocuments()).toBe(0);
    });

    it("keeps the note to one clean line of up to 140 characters", async () => {
      const admin = await boss();
      await signup(app, "ann");
      expect((await put(admin, 1, { username: "ann", note: "x".repeat(141) })).body.error).toBe("Spotlight note can be up to 140 characters");
      expect((await put(admin, 1, { username: "ann", note: 5 })).body.error).toBe("Spotlight note must be text");
      expect((await put(admin, 1, { username: "ann", note: { $ne: "" } })).status).toBe(400);
      expect((await put(admin, 1, { username: "ann", note: "x".repeat(140) })).status).toBe(200);
      const cleaned = await put(admin, 1, { username: "ann", note: "<b>Murals</b>\nand   posters" });
      expect(cleaned.body.slots[0].note).toBe("<b>Murals</b> and posters");
      expect((await put(admin, 1, { username: "ann" })).body.slots[0].note).toBe("");
    });

    it("accepts only one of the person's own pictures", async () => {
      const admin = await boss();
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const mine = await piece(ann, "mine");
      const his = await piece(ben, "his");
      const video = await ann.agent.post("/api/media").send({ type: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
      for (const bad of [his.id, "nope", video.body.mediaItem?.id ?? "x"]) {
        const res = await put(admin, 1, { username: "ann", pieceId: bad });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Pick one of their pictures, or leave it automatic");
      }
      const ok = await put(admin, 1, { username: "ann", pieceId: mine.id });
      expect(ok.status).toBe(200);
      expect(ok.body.slots[0]).toMatchObject({ chosenPiece: mine.id, piece: { caption: "mine" } });
      // leaving it out goes back to automatic
      expect((await put(admin, 1, { username: "ann" })).body.slots[0].chosenPiece).toBeNull();
    });
  });
});
