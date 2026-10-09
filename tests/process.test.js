import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

// A fake Cloudinary that only records which files were deleted.
const destroyed = [];
vi.mock("cloudinary", () => ({
  v2: { config: vi.fn(), uploader: { destroy: vi.fn(async (publicId) => { destroyed.push(publicId); return { result: "ok" }; }), upload: vi.fn(), upload_stream: vi.fn() } },
}));

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.121.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("process: how a piece was made", () => {
  let app, StoredAsset, ProcessStep, MediaItem;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ StoredAsset } = await import("../models/StoredAsset.js"));
    ({ ProcessStep } = await import("../models/ProcessStep.js"));
    ({ MediaItem } = await import("../models/MediaItem.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
    destroyed.length = 0;
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const piece = async (who, name = "vase") => (await who.agent.post("/api/media").send({ type: "image", url: `https://img.example.com/${name}.png`, caption: name })).body.mediaItem;
  const step = (who, pieceId, body) => who.agent.post(`/api/media/${pieceId}/process`).send(body);
  const steps = async (who, pieceId) => (await who.agent.get(`/api/media/${pieceId}/process`)).body.steps;
  const upload = async (who, n = 1) => {
    const url = `https://res.cloudinary.example/image/upload/v1/creativeselect/comments/step${n}-${who.user.username}.png`;
    await StoredAsset.create({ owner: who.user.id, url, publicId: `creativeselect/comments/step${n}-${who.user.username}`, resourceType: "image", kind: "upload" });
    return url;
  };

  describe("adding", () => {
    it("adds steps to your own piece, which come back in the order they were added", async () => {
      const zoe = await signup(app, "zoe");
      const vase = await piece(zoe);
      expect((await step(zoe, vase.id, { content: "First sketch" })).status).toBe(201);
      expect((await step(zoe, vase.id, { content: "Throwing the shape" })).status).toBe(201);
      expect((await step(zoe, vase.id, { content: "Glaze test" })).status).toBe(201);
      expect((await steps(zoe, vase.id)).map((s) => s.content)).toEqual(["First sketch", "Throwing the shape", "Glaze test"]);
    });

    it("takes a picture on its own, one the person uploaded, and refuses one they didn't", async () => {
      const zoe = await signup(app, "zoe");
      const vase = await piece(zoe);
      const url = await upload(zoe);
      const ok = await step(zoe, vase.id, { imageUrl: url });
      expect(ok.status).toBe(201);
      expect(ok.body.step).toMatchObject({ content: "", imageUrl: url });
      expect((await step(zoe, vase.id, { imageUrl: "https://elsewhere.example/x.png" })).status).toBe(400);
      const kai = await signup(app, "kai");
      expect((await step(zoe, vase.id, { imageUrl: await upload(kai) })).status).toBe(400); // someone else's upload
    });

    it("needs words or a picture, and checks the words like a comment", async () => {
      const zoe = await signup(app, "zoe");
      const vase = await piece(zoe);
      for (const body of [{}, { content: "   " }, { content: 5 }, { content: "x".repeat(501) }, { content: "a https://a.example b https://b.example c https://c.example d https://d.example" }]) {
        expect((await step(zoe, vase.id, body)).status, JSON.stringify(body)).toBe(400);
      }
      expect((await step(zoe, vase.id, { content: "x".repeat(500) })).status).toBe(201);
    });

    it("stops at twelve steps", async () => {
      const zoe = await signup(app, "zoe");
      const vase = await piece(zoe);
      const id = (await MediaItem.findById(vase.id)).owner;
      await ProcessStep.insertMany(Array.from({ length: 12 }, (_, i) => ({ piece: vase.id, owner: id, content: `step ${i}`, position: i })));
      const res = await step(zoe, vase.id, { content: "one too many" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/up to 12 steps/);
    });

    it("only lets the owner add, and answers 404 for anyone else's piece, a missing one, or a bad id", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const vase = await piece(zoe);
      expect((await step(kai, vase.id, { content: "mine now" })).status).toBe(404);
      expect((await step(kai, "64b64b64b64b64b64b64b64b", { content: "x" })).status).toBe(404);
      expect((await step(kai, "nope", { content: "x" })).status).toBe(404);
      expect((await request(app).post(`/api/media/${vase.id}/process`).send({ content: "x" })).status).toBe(401);
      expect(await ProcessStep.countDocuments({})).toBe(0);
    });
  });

  describe("seeing", () => {
    it("shows the steps to anyone who can see the piece, signed in or not", async () => {
      const zoe = await signup(app, "zoe");
      const vase = await piece(zoe);
      await step(zoe, vase.id, { content: "Sketch" });
      const seen = await request(app).get(`/api/media/${vase.id}/process`);
      expect(seen.status).toBe(200);
      expect(seen.body.steps).toHaveLength(1);
    });

    it("answers 404 where the piece can't be seen: a private profile, a block, a missing piece", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const vase = await piece(zoe);
      await step(zoe, vase.id, { content: "Secret sketch" });
      await zoe.agent.post("/api/users/liv/block");
      expect((await liv.agent.get(`/api/media/${vase.id}/process`)).status).toBe(404);
      await zoe.agent.patch("/api/profiles/me").send({ isPrivate: true });
      const refused = await kai.agent.get(`/api/media/${vase.id}/process`);
      expect(refused.status).toBe(404);
      expect(JSON.stringify(refused.body)).not.toContain("Secret");
      expect((await request(app).get(`/api/media/${vase.id}/process`)).status).toBe(404);
      expect((await zoe.agent.get(`/api/media/${vase.id}/process`)).status).toBe(200);
    });

    it("tells how many steps each piece has in the portfolio list", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const vase = await piece(zoe, "vase");
      await piece(zoe, "bowl");
      await step(zoe, vase.id, { content: "a" });
      await step(zoe, vase.id, { content: "b" });
      const list = (await kai.agent.get("/api/media/user/zoe")).body.media;
      expect(Object.fromEntries(list.map((m) => [m.caption, m.processCount]))).toEqual({ vase: 2, bowl: 0 });
    });
  });

  describe("changing", () => {
    it("changes the words, marks it edited, and refuses an empty step", async () => {
      const zoe = await signup(app, "zoe");
      const vase = await piece(zoe);
      const made = (await step(zoe, vase.id, { content: "Frst sketch" })).body.step;
      const fixed = await zoe.agent.patch(`/api/media/process/${made.id}`).send({ content: "First sketch" });
      expect(fixed.status).toBe(200);
      expect(fixed.body.step.content).toBe("First sketch");
      expect(fixed.body.step.editedAt).toBeTruthy();
      expect((await zoe.agent.patch(`/api/media/process/${made.id}`).send({ content: "  " })).status).toBe(400);
      expect((await zoe.agent.patch(`/api/media/process/${made.id}`).send({})).status).toBe(400);
    });

    it("takes a picture off a step but never swaps it, and deletes the stored file", async () => {
      const zoe = await signup(app, "zoe");
      const vase = await piece(zoe);
      const url = await upload(zoe, 1);
      const made = (await step(zoe, vase.id, { content: "With a picture", imageUrl: url })).body.step;
      const swap = await zoe.agent.patch(`/api/media/process/${made.id}`).send({ imageUrl: await upload(zoe, 2) });
      expect(swap.status).toBe(400);
      const off = await zoe.agent.patch(`/api/media/process/${made.id}`).send({ imageUrl: null });
      expect(off.status).toBe(200);
      expect(off.body.step.imageUrl).toBe(null);
      expect(destroyed).toEqual([`creativeselect/comments/step1-zoe`]);
    });

    it("only changes or deletes your own steps", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const vase = await piece(zoe);
      const made = (await step(zoe, vase.id, { content: "Hers" })).body.step;
      expect((await kai.agent.patch(`/api/media/process/${made.id}`).send({ content: "His" })).status).toBe(404);
      expect((await kai.agent.delete(`/api/media/process/${made.id}`)).status).toBe(404);
      expect((await zoe.agent.patch("/api/media/process/nope").send({ content: "x" })).status).toBe(404);
      expect((await steps(zoe, vase.id))[0].content).toBe("Hers");
    });

    it("deletes a step with its picture", async () => {
      const zoe = await signup(app, "zoe");
      const vase = await piece(zoe);
      const made = (await step(zoe, vase.id, { imageUrl: await upload(zoe) })).body.step;
      expect((await zoe.agent.delete(`/api/media/process/${made.id}`)).status).toBe(204);
      expect(await steps(zoe, vase.id)).toEqual([]);
      expect(destroyed).toHaveLength(1);
    });
  });

  describe("order", () => {
    it("puts the steps in a new order, which must name every step once", async () => {
      const zoe = await signup(app, "zoe");
      const vase = await piece(zoe);
      const a = (await step(zoe, vase.id, { content: "A" })).body.step;
      const b = (await step(zoe, vase.id, { content: "B" })).body.step;
      const c = (await step(zoe, vase.id, { content: "C" })).body.step;
      const put = (ids) => zoe.agent.put(`/api/media/${vase.id}/process/order`).send({ ids });
      const moved = await put([c.id, a.id, b.id]);
      expect(moved.status).toBe(200);
      expect(moved.body.steps.map((s) => s.content)).toEqual(["C", "A", "B"]);
      expect((await steps(zoe, vase.id)).map((s) => s.content)).toEqual(["C", "A", "B"]);
      for (const bad of [[a.id, b.id], [a.id, a.id, b.id], [a.id, b.id, "64b64b64b64b64b64b64b64b"], "abc", [1, 2, 3]]) expect((await put(bad)).status, JSON.stringify(bad)).toBe(400);
      // and new steps go on the end
      await step(zoe, vase.id, { content: "D" });
      expect((await steps(zoe, vase.id)).map((s) => s.content)).toEqual(["C", "A", "B", "D"]);
    });

    it("lets only the owner reorder", async () => {
      const zoe = await signup(app, "zoe");
      const kai = await signup(app, "kai");
      const vase = await piece(zoe);
      const a = (await step(zoe, vase.id, { content: "A" })).body.step;
      expect((await kai.agent.put(`/api/media/${vase.id}/process/order`).send({ ids: [a.id] })).status).toBe(404);
    });
  });

  describe("tidying up", () => {
    it("takes the steps and their pictures away with the piece", async () => {
      const zoe = await signup(app, "zoe");
      const vase = await piece(zoe);
      await step(zoe, vase.id, { content: "A", imageUrl: await upload(zoe) });
      await step(zoe, vase.id, { content: "B" });
      expect((await zoe.agent.delete(`/api/media/${vase.id}`)).status).toBe(204);
      expect(await ProcessStep.countDocuments({})).toBe(0);
      expect(destroyed).toHaveLength(1);
    });

    it("takes them away with the account, and puts them in the data download", async () => {
      const zoe = await signup(app, "zoe");
      const vase = await piece(zoe);
      await step(zoe, vase.id, { content: "Sketch" });
      const data = JSON.parse((await zoe.agent.post("/api/profiles/me/export").send({ password: "password123" })).text);
      expect(data.processSteps).toHaveLength(1);
      expect(data.processSteps[0]).toMatchObject({ piece: vase.id, text: "Sketch", position: 0 });
      expect((await zoe.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await ProcessStep.countDocuments({})).toBe(0);
    });
  });
});
