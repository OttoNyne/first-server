import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.123.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("reporting more kinds of things", () => {
  let app, M;
  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "boss@example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      Post: (await import("../models/Post.js")).Post,
      PollVote: (await import("../models/PollVote.js")).PollVote,
      Save: (await import("../models/Save.js")).Save,
      MediaItem: (await import("../models/MediaItem.js")).MediaItem,
      ProcessStep: (await import("../models/ProcessStep.js")).ProcessStep,
      Call: (await import("../models/Call.js")).Call,
      CallApplication: (await import("../models/CallApplication.js")).CallApplication,
      Notification: (await import("../models/Notification.js")).Notification,
      Report: (await import("../models/Report.js")).Report,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    await clearTestDb();
    await disconnectTestDb();
  });

  const makeAdmin = async () => {
    const a = await signup(app, "boss");
    await M.User.updateOne({ _id: a.user.id }, { $set: { emailVerified: true } });
    return a;
  };
  const report = (who, targetType, targetId, reason = "not ok") => who.agent.post("/api/reports").send({ targetType, targetId: String(targetId), reason });
  const queue = async (admin) => (await admin.agent.get("/api/admin/reports")).body.cases;
  const resolve = (admin, targetType, targetId, action) => admin.agent.post("/api/admin/reports/resolve").send({ targetType, targetId: String(targetId), action });

  async function world() {
    const boss = await makeAdmin();
    const owner = await signup(app, "owner");
    const rep = await signup(app, "rep");
    const piece = (await owner.agent.post("/api/media").send({ type: "image", url: "https://img.example.com/p.png", caption: "A rude caption" })).body.mediaItem;
    const step = (await owner.agent.post(`/api/media/${piece.id}/process`).send({ content: "A rude step" })).body.step;
    const call = (await owner.agent.post("/api/calls").send({ title: "A rude call", details: "Rude details", lookingFor: ["vocalist"] })).body.call;
    await rep.agent.post(`/api/calls/${call.id}/apply`).send({ note: "A rude answer" });
    const application = await M.CallApplication.findOne({ call: call.id });
    return { boss, owner, rep, piece, step, call, application };
  }

  it("takes reports about a portfolio piece, a step, a call and an answer, and shows each with a preview and a link", async () => {
    const { boss, rep, owner, piece, step, call, application } = await world();
    const reporter = await signup(app, "other");
    for (const [type, id] of [["piece", piece.id], ["processStep", step.id], ["call", call.id], ["callApplication", application._id]]) {
      expect((await report(reporter, type, id, `${type} reason`)).status, type).toBe(201);
    }
    const cases = Object.fromEntries((await queue(boss)).map((c) => [c.targetType, c]));
    expect(cases.piece.target).toMatchObject({ text: "A rude caption", link: `/u/owner?piece=${piece.id}#portfolio` });
    expect(cases.piece.target.author.username).toBe("owner");
    expect(cases.processStep.target).toMatchObject({ text: "A rude step", link: `/u/owner?piece=${piece.id}#portfolio` });
    expect(cases.call.target).toMatchObject({ title: "A rude call", link: `/calls/${call.id}` });
    expect(cases.call.target.text).toContain("Rude details");
    expect(cases.call.target.text).toContain("vocalist");
    expect(cases.callApplication.target).toMatchObject({ text: "A rude answer", link: `/calls/${call.id}` });
    expect(cases.callApplication.target.author.username).toBe("rep");
    expect(owner).toBeTruthy();
  });

  it("checks that the thing exists, like any report", async () => {
    const { rep } = await world();
    for (const type of ["piece", "processStep", "call", "callApplication"]) {
      expect((await report(rep, type, "64b64b64b64b64b64b64b64b")).status, type).toBe(404);
      expect((await report(rep, type, "nope")).status, type).toBe(400);
    }
  });

  it("shows a poll's options and the words of a post that is shared, in a report about the post", async () => {
    const boss = await makeAdmin();
    const author = await signup(app, "author");
    const rep = await signup(app, "rep");
    const sharer = await signup(app, "sharer");
    const polled = (await author.agent.post("/api/posts").send({ content: "Which one?", poll: { options: ["Rude option", "Fine option"] } })).body.post;
    const shared = (await sharer.agent.post(`/api/posts/${polled.id}/repost`).send({ content: "Look at this" })).body.post;
    await report(rep, "post", polled.id);
    await report(rep, "post", shared.id);
    const cases = Object.fromEntries((await queue(boss)).map((c) => [c.targetId, c]));
    expect(cases[polled.id].target.text).toBe("Which one?\nPoll: Rude option / Fine option");
    expect(cases[shared.id].target.text).toBe("Look at this\nShares: Which one?");
  });

  it("removes each the way its owner deleting it would, and tells the owner and the reporters", async () => {
    const { boss, rep, owner, piece, step, call, application } = await world();
    const picked = await M.CallApplication.findOne({ call: call.id });
    expect(picked).toBeTruthy();
    for (const [type, id, Model] of [
      ["callApplication", application._id, M.CallApplication],
      ["processStep", step.id, M.ProcessStep],
      ["call", call.id, M.Call],
      ["piece", piece.id, M.MediaItem],
    ]) {
      await report(rep, type, id);
      const res = await resolve(boss, type, id, "remove");
      expect(res.status, type).toBe(200);
      expect(res.body.removed, type).toBe(true);
      expect(await Model.findById(id), type).toBeNull();
    }
    expect(await M.ProcessStep.countDocuments({})).toBe(0);
    const told = (await owner.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "content_removed");
    expect(told.map((n) => n.payload.what).sort()).toEqual(["open call", "portfolio piece", "step of a portfolio piece"]);
    const toApplicant = (await rep.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "content_removed");
    expect(toApplicant.map((n) => n.payload.what)).toEqual(["answer to an open call"]);
    const thanked = (await rep.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "report_resolved");
    expect(thanked).toHaveLength(4);
  });

  it("removing a call takes its answers and notices with it, and removing a piece takes its steps", async () => {
    const { boss, rep, owner, piece, call } = await world();
    expect(await M.Notification.countDocuments({ type: "call_application" })).toBe(1);
    await report(rep, "call", call.id);
    await resolve(boss, "call", call.id, "remove");
    expect(await M.CallApplication.countDocuments({})).toBe(0);
    expect(await M.Notification.countDocuments({ type: "call_application" })).toBe(0);
    await report(rep, "piece", piece.id);
    await resolve(boss, "piece", piece.id, "remove");
    expect(await M.ProcessStep.countDocuments({})).toBe(0);
    expect(owner).toBeTruthy();
  });

  it("removing a post leaves no votes, saves or pin behind (the same cleanup as its author deleting it)", async () => {
    const boss = await makeAdmin();
    const author = await signup(app, "author");
    const voter = await signup(app, "voter");
    const rep = await signup(app, "rep");
    const post = (await author.agent.post("/api/posts").send({ content: "A post with a poll", poll: { options: ["A", "B"] } })).body.post;
    await voter.agent.put(`/api/posts/${post.id}/poll/vote`).send({ option: 0 });
    await voter.agent.put(`/api/saves/posts/${post.id}`);
    await author.agent.put(`/api/posts/${post.id}/pin`);
    await report(rep, "post", post.id);
    expect((await resolve(boss, "post", post.id, "remove")).status).toBe(200);
    expect(await M.PollVote.countDocuments({})).toBe(0);
    expect(await M.Save.countDocuments({})).toBe(0);
    expect((await M.User.findById(author.user.id)).pinnedPost).toBeNull();
  });

  it("can suspend the person behind a call or an answer", async () => {
    const { boss, rep, owner, call } = await world();
    await report(rep, "call", call.id);
    expect((await resolve(boss, "call", call.id, "suspend")).status).toBe(200);
    expect((await M.User.findById(owner.user.id)).suspendedAt).not.toBeNull();
  });
});
