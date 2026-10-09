import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.126.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("critique requests", () => {
  let app, M;
  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "boss@example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      MediaItem: (await import("../models/MediaItem.js")).MediaItem,
      Critique: (await import("../models/Critique.js")).Critique,
      CritiqueNote: (await import("../models/CritiqueNote.js")).CritiqueNote,
      Notification: (await import("../models/Notification.js")).Notification,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    await clearTestDb();
    await disconnectTestDb();
  });

  const piece = async (who, name = "vase") => (await who.agent.post("/api/media").send({ type: "image", url: `https://img.example.com/${name}.png`, caption: name })).body.mediaItem;
  const ask = (who, pieceId, question) => who.agent.post("/api/critiques").send({ piece: pieceId, ...(question !== undefined ? { question } : {}) });
  const give = (who, id, body = { working: "The colours", change: "The edges" }) => who.agent.post(`/api/critiques/${id}/notes`).send(body);
  const board = async (who, query = "") => (await who.agent.get(`/api/critiques${query}`)).body;
  const noticesOf = (who, type) => M.Notification.find({ recipient: who.user.id, type });

  async function request_() {
    const owner = await signup(app, "owner");
    const vase = await piece(owner);
    const asked = (await ask(owner, vase.id, "Is the glaze too loud?")).body.critique;
    return { owner, vase, id: asked.id };
  }

  describe("asking", () => {
    it("asks for feedback on your own piece, with a question if you like", async () => {
      const owner = await signup(app, "owner");
      const vase = await piece(owner);
      const res = await ask(owner, vase.id, "  Is the glaze   too loud? ");
      expect(res.status).toBe(201);
      expect(res.body.critique).toMatchObject({ question: "Is the glaze too loud?", status: "open", mine: true, noteCount: 0, piece: { id: vase.id, caption: "vase" } });
      expect((await ask(owner, (await piece(owner, "bowl")).id)).status).toBe(201); // no question is fine
    });

    it("refuses someone else's piece, a missing one, a long question, and a second open request for the same piece", async () => {
      const owner = await signup(app, "owner");
      const kai = await signup(app, "kai");
      const vase = await piece(owner);
      expect((await ask(kai, vase.id)).status).toBe(404);
      expect((await ask(owner, "64b64b64b64b64b64b64b64b")).status).toBe(404);
      expect((await ask(owner, "nope")).status).toBe(404);
      expect((await ask(owner, vase.id, "x".repeat(301))).status).toBe(400);
      expect((await ask(owner, vase.id, 5)).status).toBe(400);
      expect((await ask(owner, vase.id)).status).toBe(201);
      const again = await ask(owner, vase.id);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("This piece already has an open request");
      expect((await request(app).post("/api/critiques").send({ piece: vase.id })).status).toBe(401);
    });

    it("allows three open requests at a time, and a closed one makes room", async () => {
      const owner = await signup(app, "owner");
      const ids = [];
      for (const name of ["a1p", "b2p", "c3p"]) ids.push((await ask(owner, (await piece(owner, name)).id)).body.critique.id);
      const fourth = await ask(owner, (await piece(owner, "d4p")).id);
      expect(fourth.status).toBe(409);
      expect(fourth.body.error).toMatch(/up to 3 open requests/);
      await owner.agent.patch(`/api/critiques/${ids[0]}`).send({ status: "closed" });
      expect((await ask(owner, (await piece(owner, "d4p")).id)).status).toBe(201);
    });

    it("limits how many a person asks in a day", async () => {
      const owner = await signup(app, "owner");
      await M.RateLimitHit.insertMany(Array.from({ length: 10 }, () => ({ key: `critique-ask:${owner.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
      expect((await ask(owner, (await piece(owner)).id)).status).toBe(429);
    });
  });

  describe("the board", () => {
    it("lists other people's open requests, newest first, with how many have answered and whether you did", async () => {
      const owner = await signup(app, "owner");
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const older = (await ask(owner, (await piece(owner, "older")).id)).body.critique;
      const newer = (await ask(owner, (await piece(owner, "newer")).id)).body.critique;
      await give(kai, older.id);
      const seen = (await board(kai)).critiques;
      expect(seen.map((c) => [c.piece.caption, c.noteCount, c.answered])).toEqual([["newer", 0, false], ["older", 1, true]]);
      expect((await board(liv)).critiques.map((c) => c.answered)).toEqual([false, false]);
      expect((await board(owner)).critiques).toEqual([]); // never your own
      expect(newer.id).toBeTruthy();
    });

    it("leaves out closed requests, and requests from people you can't see or have muted", async () => {
      const owner = await signup(app, "owner");
      const hidden = await signup(app, "hidden");
      const blocker = await signup(app, "blocker");
      const quiet = await signup(app, "quiet");
      const viewer = await signup(app, "viewer");
      const closed = (await ask(owner, (await piece(owner, "closedp")).id)).body.critique;
      await owner.agent.patch(`/api/critiques/${closed.id}`).send({ status: "closed" });
      await ask(owner, (await piece(owner, "openp")).id);
      for (const who of [hidden, blocker, quiet]) await ask(who, (await piece(who, `${who.user.username}p`)).id);
      await hidden.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await blocker.agent.post("/api/users/viewer/block");
      await viewer.agent.put("/api/mutes/people/quiet");
      expect((await board(viewer)).critiques.map((c) => c.piece.caption)).toEqual(["openp"]);
    });

    it("pages with a cursor", async () => {
      const owner = await signup(app, "owner");
      const kai = await signup(app, "kai");
      const id = (await M.User.findOne({ username: "owner" }))._id;
      const items = await M.MediaItem.insertMany(Array.from({ length: 25 }, (_, i) => ({ owner: id, type: "image", url: `https://img.example.com/${i}.png`, caption: `p${i}` })));
      await M.Critique.insertMany(items.map((m) => ({ piece: m._id, owner: id })));
      const first = await board(kai);
      expect(first.critiques).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      const second = await board(kai, `?before=${first.next}`);
      expect(second.critiques).toHaveLength(5);
      expect(second.hasMore).toBe(false);
      expect(owner).toBeTruthy();
    });
  });

  describe("giving feedback", () => {
    it("writes two notes, tells the owner, and only the owner and the writer can read them", async () => {
      const { owner, id } = await request_();
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      const res = await give(kai, id, { working: "  The colours  ", change: "The edges" });
      expect(res.status).toBe(201);
      expect(res.body.note).toMatchObject({ working: "The colours", change: "The edges", thanked: false });
      await give(liv, id, { working: "Lovely shape" });
      const notices = await noticesOf(owner, "critique_note");
      expect(notices).toHaveLength(2);
      expect(notices[0].payload).toMatchObject({ critiqueId: id, title: "vase" });
      // the owner reads both
      const mine = (await owner.agent.get(`/api/critiques/${id}`)).body.critique;
      expect(mine.noteCount).toBe(2);
      expect(mine.notes.map((n) => [n.author.username, n.working, n.change])).toEqual([["liv", "Lovely shape", ""], ["kai", "The colours", "The edges"]]);
      // a writer reads only their own
      const theirs = (await kai.agent.get(`/api/critiques/${id}`)).body.critique;
      expect(theirs.notes).toBeUndefined();
      expect(theirs.noteCount).toBe(2);
      expect(theirs.myNote).toMatchObject({ working: "The colours" });
      // someone who hasn't answered sees the count and the question only
      const other = await signup(app, "other");
      const stranger = (await other.agent.get(`/api/critiques/${id}`)).body.critique;
      expect(stranger).toMatchObject({ noteCount: 2, myNote: null, question: "Is the glaze too loud?" });
      expect(JSON.stringify(stranger)).not.toContain("The colours");
    });

    it("needs something written, checks the words, and takes one answer each", async () => {
      const { id } = await request_();
      const kai = await signup(app, "kai");
      for (const body of [{}, { working: "  " }, { working: 5 }, { working: "x".repeat(501) }, { change: "x".repeat(501) }, { working: "https://a.example https://b.example https://c.example https://d.example" }]) {
        expect((await give(kai, id, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
      }
      expect((await give(kai, id, { change: "Only a change" })).status).toBe(201);
      const twice = await give(kai, id);
      expect(twice.status).toBe(409);
      expect(twice.body.error).toBe("You have already given feedback on this");
    });

    it("is not for your own piece, a closed request, or someone who can't see the owner", async () => {
      const { owner, id } = await request_();
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      expect((await give(owner, id)).status).toBe(400);
      await owner.agent.post("/api/users/liv/block");
      expect((await give(liv, id)).status).toBe(404);
      await owner.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await give(kai, id)).status).toBe(404);
      await owner.agent.patch("/api/profiles/me").send({ isPrivate: false });
      await owner.agent.patch(`/api/critiques/${id}`).send({ status: "closed" });
      const late = await give(kai, id);
      expect(late.status).toBe(404); // a closed request is gone for people who hadn't answered
      expect((await request(app).post(`/api/critiques/${id}/notes`).send({ working: "x" })).status).toBe(401);
    });

    it("lets the writer change or take back a note while it is open", async () => {
      const { owner, id } = await request_();
      const kai = await signup(app, "kai");
      await give(kai, id);
      const edited = await kai.agent.patch(`/api/critiques/${id}/notes/mine`).send({ working: "Changed my mind", change: "" });
      expect(edited.status).toBe(200);
      expect(edited.body.note).toMatchObject({ working: "Changed my mind", change: "" });
      expect(edited.body.note.editedAt).toBeTruthy();
      expect((await kai.agent.patch(`/api/critiques/${id}/notes/mine`).send({})).status).toBe(400);
      expect((await kai.agent.delete(`/api/critiques/${id}/notes/mine`)).status).toBe(204);
      expect(await M.CritiqueNote.countDocuments({})).toBe(0);
      expect(await noticesOf(owner, "critique_note")).toHaveLength(0);
      expect((await kai.agent.delete(`/api/critiques/${id}/notes/mine`)).status).toBe(404);
      expect((await kai.agent.patch(`/api/critiques/${id}/notes/mine`).send({ working: "x" })).status).toBe(404);
    });

    it("limits how much one person gives in a day", async () => {
      const { id } = await request_();
      const kai = await signup(app, "kai");
      await M.RateLimitHit.insertMany(Array.from({ length: 30 }, () => ({ key: `critique-note:${kai.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
      expect((await give(kai, id)).status).toBe(429);
    });
  });

  describe("the owner's side", () => {
    it("says thank you once, however often, and the writer is told", async () => {
      const { owner, id } = await request_();
      const kai = await signup(app, "kai");
      const note = (await give(kai, id)).body.note;
      const thanks = () => owner.agent.put(`/api/critiques/${id}/notes/${note.id}/thanks`);
      expect((await thanks()).body.note.thanked).toBe(true);
      await thanks();
      expect(await noticesOf(kai, "critique_thanks")).toHaveLength(1);
      expect((await kai.agent.get(`/api/critiques/${id}`)).body.critique.myNote.thanked).toBe(true);
      expect((await kai.agent.put(`/api/critiques/${id}/notes/${note.id}/thanks`)).status).toBe(404); // only the owner thanks
    });

    it("takes a note away, and only for the owner", async () => {
      const { owner, id } = await request_();
      const kai = await signup(app, "kai");
      const note = (await give(kai, id)).body.note;
      expect((await kai.agent.delete(`/api/critiques/${id}/notes/${note.id}`)).status).toBe(404);
      expect((await owner.agent.delete(`/api/critiques/${id}/notes/${note.id}`)).status).toBe(204);
      expect(await M.CritiqueNote.countDocuments({})).toBe(0);
    });

    it("changes the question, closes and reopens, and refuses reopening a second for the same piece", async () => {
      const { owner, vase, id } = await request_();
      const patch = (body) => owner.agent.patch(`/api/critiques/${id}`).send(body);
      expect((await patch({ question: "Better question" })).body.critique.question).toBe("Better question");
      expect((await patch({ status: "closed" })).body.critique).toMatchObject({ status: "closed", closed: true });
      expect((await ask(owner, vase.id)).status).toBe(201); // asked again while the first is closed
      const reopen = await patch({ status: "open" });
      expect(reopen.status).toBe(409);
      for (const body of [{}, { status: "paused" }, { question: "x".repeat(301) }]) expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
      const kai = await signup(app, "kai");
      expect((await kai.agent.patch(`/api/critiques/${id}`).send({ status: "closed" })).status).toBe(404);
    });

    it("keeps a closed request readable by those who answered, and the owner", async () => {
      const { owner, id } = await request_();
      const kai = await signup(app, "kai");
      const liv = await signup(app, "liv");
      await give(kai, id);
      await owner.agent.patch(`/api/critiques/${id}`).send({ status: "closed" });
      expect((await kai.agent.get(`/api/critiques/${id}`)).status).toBe(200);
      expect((await owner.agent.get(`/api/critiques/${id}`)).status).toBe(200);
      expect((await liv.agent.get(`/api/critiques/${id}`)).status).toBe(404);
      expect((await kai.agent.patch(`/api/critiques/${id}/notes/mine`).send({ working: "late" })).status).toBe(409);
    });

    it("lists your requests and what you answered", async () => {
      const { owner, id } = await request_();
      const kai = await signup(app, "kai");
      await give(kai, id);
      const mine = (await owner.agent.get("/api/critiques/mine")).body.critiques;
      expect(mine.map((c) => [c.id, c.noteCount])).toEqual([[id, 1]]);
      const answered = (await kai.agent.get("/api/critiques/answered")).body.answers;
      expect(answered).toHaveLength(1);
      expect(answered[0]).toMatchObject({ note: { working: "The colours" }, critique: { id, owner: { username: "owner" } } });
      expect((await owner.agent.get("/api/critiques/answered")).body.answers).toEqual([]);
    });

    it("deletes a request with its notes and notices", async () => {
      const { owner, id } = await request_();
      const kai = await signup(app, "kai");
      await give(kai, id);
      expect((await kai.agent.delete(`/api/critiques/${id}`)).status).toBe(404);
      expect((await owner.agent.delete(`/api/critiques/${id}`)).status).toBe(204);
      expect(await M.Critique.countDocuments({})).toBe(0);
      expect(await M.CritiqueNote.countDocuments({})).toBe(0);
      expect(await noticesOf(owner, "critique_note")).toHaveLength(0);
    });
  });

  describe("on the portfolio", () => {
    it("marks a piece that has an open request, with how many have answered", async () => {
      const { owner, vase, id } = await request_();
      const kai = await signup(app, "kai");
      await piece(owner, "plain");
      await give(kai, id);
      const list = (await kai.agent.get("/api/media/user/owner")).body.media;
      expect(Object.fromEntries(list.map((m) => [m.caption, m.critique]))).toEqual({ vase: { id, noteCount: 1 }, plain: null });
      await owner.agent.patch(`/api/critiques/${id}`).send({ status: "closed" });
      expect((await kai.agent.get("/api/media/user/owner")).body.media.find((m) => m.id === vase.id).critique).toBe(null);
    });

    it("goes with the piece", async () => {
      const { owner, vase, id } = await request_();
      const kai = await signup(app, "kai");
      await give(kai, id);
      expect((await owner.agent.delete(`/api/media/${vase.id}`)).status).toBe(204);
      expect(await M.Critique.countDocuments({})).toBe(0);
      expect(await M.CritiqueNote.countDocuments({})).toBe(0);
    });
  });

  describe("reporting", () => {
    it("lets the owner report a note (and anyone a request), shows both to a moderator, and removes them", async () => {
      const { owner, id } = await request_();
      const kai = await signup(app, "kai");
      const note = (await give(kai, id, { working: "A rude note", change: "" })).body.note;
      const report = (who, targetType, targetId) => who.agent.post("/api/reports").send({ targetType, targetId, reason: "Rude" });
      expect((await report(kai, "critiqueNote", note.id)).status).toBe(404); // not for the writer, or anyone but the owner
      expect((await report(owner, "critiqueNote", note.id)).status).toBe(201);
      expect((await report(kai, "critique", id)).status).toBe(201);
      const boss = await signup(app, "boss");
      await M.User.updateOne({ _id: boss.user.id }, { $set: { emailVerified: true } });
      const cases = Object.fromEntries((await boss.agent.get("/api/admin/reports")).body.cases.map((c) => [c.targetType, c]));
      expect(cases.critiqueNote.target).toMatchObject({ text: "What is working: A rude note", link: `/critiques/${id}` });
      expect(cases.critique.target).toMatchObject({ text: "Is the glaze too loud?" });
      expect((await boss.agent.post("/api/admin/reports/resolve").send({ targetType: "critiqueNote", targetId: note.id, action: "remove" })).body.removed).toBe(true);
      expect(await M.CritiqueNote.countDocuments({})).toBe(0);
      expect((await boss.agent.post("/api/admin/reports/resolve").send({ targetType: "critique", targetId: id, action: "remove" })).body.removed).toBe(true);
      expect(await M.Critique.countDocuments({})).toBe(0);
    });
  });

  describe("tidying up", () => {
    it("removes a person's requests and notes with their account, and lists them in the data download", async () => {
      const { owner, id } = await request_();
      const kai = await signup(app, "kai");
      await give(kai, id);
      const mine = JSON.parse((await owner.agent.post("/api/profiles/me/export").send({ password: "password123" })).text);
      expect(mine.critiqueRequests).toMatchObject([{ id, question: "Is the glaze too loud?", notesReceived: 1 }]);
      const theirs = JSON.parse((await kai.agent.post("/api/profiles/me/export").send({ password: "password123" })).text);
      expect(theirs.critiqueNotes).toMatchObject([{ request: id, working: "The colours", change: "The edges" }]);
      expect((await kai.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await M.CritiqueNote.countDocuments({})).toBe(0);
      expect(await noticesOf(owner, "critique_note")).toHaveLength(0);
      expect(await M.Critique.countDocuments({})).toBe(1);
      expect((await owner.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await M.Critique.countDocuments({})).toBe(0);
    });
  });
});
