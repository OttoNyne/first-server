import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

const destroyed = [];
vi.mock("cloudinary", () => ({
  v2: { config: vi.fn(), uploader: { destroy: vi.fn(async (publicId) => { destroyed.push(publicId); return { result: "ok" }; }), upload: vi.fn(), upload_stream: vi.fn() } },
}));

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.124.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("project rooms", () => {
  let app, M;
  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "boss@example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      Call: (await import("../models/Call.js")).Call,
      Project: (await import("../models/Project.js")).Project,
      ProjectMessage: (await import("../models/ProjectMessage.js")).ProjectMessage,
      ProjectTask: (await import("../models/ProjectTask.js")).ProjectTask,
      StoredAsset: (await import("../models/StoredAsset.js")).StoredAsset,
      Notification: (await import("../models/Notification.js")).Notification,
      Report: (await import("../models/Report.js")).Report,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    destroyed.length = 0;
  });
  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    await clearTestDb();
    await disconnectTestDb();
  });

  const NEW = { title: "A vocalist for an EP", details: "A warm alto for three songs.", lookingFor: ["vocalist"] };
  // an owner with a call, and people who answered it
  async function setup(...names) {
    const owner = await signup(app, "owner");
    const call = (await owner.agent.post("/api/calls").send(NEW)).body.call;
    const people = [];
    for (const name of names) {
      const p = await signup(app, name);
      await p.agent.post(`/api/calls/${call.id}/apply`).send({ note: `${name} here` });
      people.push(p);
    }
    return { owner, call, people };
  }
  const choose = async (owner, call, person) => {
    const apps = (await owner.agent.get(`/api/calls/${call.id}/applications`)).body.applications;
    const app_ = apps.find((a) => a.applicant.username === person.user.username);
    return owner.agent.post(`/api/calls/${call.id}/applications/${app_.id}/answer`).send({ choose: true, reply: "Welcome" });
  };
  const rooms = async (who) => (await who.agent.get("/api/projects")).body.projects;
  const write = (who, room, body) => who.agent.post(`/api/projects/${room}/messages`).send(body);
  const chat = async (who, room, query = "") => (await who.agent.get(`/api/projects/${room}/messages${query}`)).body;
  const upload = async (who, n = 1) => {
    const url = `https://res.cloudinary.example/image/upload/v1/creativeselect/comments/room${n}-${who.user.username}.png`;
    await M.StoredAsset.create({ owner: who.user.id, url, publicId: `creativeselect/comments/room${n}-${who.user.username}`, resourceType: "image", kind: "upload" });
    return url;
  };

  describe("being made", () => {
    it("opens a room the first time someone is chosen, with the owner and that person in it, and tells them where it is", async () => {
      const { owner, call, people } = await setup("kai", "liv");
      expect(await rooms(owner)).toEqual([]);
      const chosen = await choose(owner, call, people[0]);
      expect(chosen.status).toBe(200);
      const roomId = chosen.body.application.projectId;
      expect(roomId).toBeTruthy();
      const list = await rooms(owner);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: roomId, title: NEW.title, status: "active", isOwner: true, callId: call.id });
      expect(list[0].members.map((m) => m.username).sort()).toEqual(["kai", "owner"]);
      // the person chosen sees it in their list and is told where it is
      expect((await rooms(people[0]))[0].id).toBe(roomId);
      const told = await M.Notification.findOne({ recipient: people[0].user.id, type: "call_answer" });
      expect(told.payload.projectId).toBe(roomId);
      // and the call page leads both of them to it
      expect((await owner.agent.get(`/api/calls/${call.id}`)).body.call.projectId).toBe(roomId);
      expect((await people[0].agent.get(`/api/calls/${call.id}`)).body.call.projectId).toBe(roomId);
      expect((await people[1].agent.get(`/api/calls/${call.id}`)).body.call.projectId).toBe(null);
    });

    it("adds each further person chosen to the same room, and passing on someone opens nothing", async () => {
      const { owner, call, people } = await setup("kai", "liv", "ann");
      const first = (await choose(owner, call, people[0])).body.application.projectId;
      const second = (await choose(owner, call, people[1])).body.application.projectId;
      expect(second).toBe(first);
      const apps = (await owner.agent.get(`/api/calls/${call.id}/applications`)).body.applications;
      await owner.agent.post(`/api/calls/${call.id}/applications/${apps.find((a) => a.applicant.username === "ann").id}/answer`).send({ choose: false });
      expect(await M.Project.countDocuments({})).toBe(1);
      expect((await rooms(owner))[0].members.map((m) => m.username).sort()).toEqual(["kai", "liv", "owner"]);
      expect(await rooms(people[2])).toEqual([]);
    });

    it("keeps a room when its call is taken down", async () => {
      const { owner, call, people } = await setup("kai");
      const room = (await choose(owner, call, people[0])).body.application.projectId;
      await owner.agent.delete(`/api/calls/${call.id}`);
      expect((await owner.agent.get(`/api/projects/${room}`)).status).toBe(200);
    });

    it("refuses to choose someone when the room is full", async () => {
      const { owner, call, people } = await setup("kai");
      const room = (await choose(owner, call, people[0])).body.application.projectId;
      const extra = await Promise.all(Array.from({ length: 6 }, (_, i) => new M.User({ email: `x${i}@example.com`, username: `x${i}`, passwordHash: "x", displayName: `X${i}` })._id));
      await M.Project.updateOne({ _id: room }, { $push: { members: { $each: extra } } });
      const late = await signup(app, "late");
      await late.agent.post(`/api/calls/${call.id}/apply`).send({ note: "me too" });
      const res = await choose(owner, call, late);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("This project room is full");
      expect((await M.Project.findById(room)).members).toHaveLength(8);
    });
  });

  describe("who can see it", () => {
    it("shows a room only to its members, with the same 404 for everyone else", async () => {
      const { owner, call, people } = await setup("kai", "liv");
      const room = (await choose(owner, call, people[0])).body.application.projectId;
      expect((await people[0].agent.get(`/api/projects/${room}`)).status).toBe(200);
      for (const outsider of [people[1], await signup(app, "stranger")]) {
        for (const [method, path] of [["get", ""], ["get", "/messages"], ["post", "/messages"], ["post", "/tasks"], ["post", "/leave"]]) {
          const res = await outsider.agent[method](`/api/projects/${room}${path}`).send({ content: "hi", text: "x" });
          expect(res.status, `${method} ${path}`).toBe(404);
        }
      }
      expect((await request(app).get(`/api/projects/${room}`)).status).toBe(401);
      expect((await people[0].agent.get("/api/projects/nope")).status).toBe(404);
      expect(await rooms(people[1])).toEqual([]);
    });
  });

  describe("the chat", () => {
    async function room(names = ["kai"]) {
      const { owner, call, people } = await setup(...names);
      let id;
      for (const p of people) id = (await choose(owner, call, p)).body.application.projectId;
      return { owner, people, id };
    }

    it("lets members write and read, oldest first, and says who wrote what", async () => {
      const { owner, people, id } = await room();
      expect((await write(owner, id, { content: "Welcome" })).status).toBe(201);
      expect((await write(people[0], id, { content: "Glad to be here" })).status).toBe(201);
      const { messages, hasMore } = await chat(people[0], id);
      expect(hasMore).toBe(false);
      expect(messages.map((m) => [m.author.username, m.content, m.mine])).toEqual([["owner", "Welcome", false], ["kai", "Glad to be here", true]]);
    });

    it("takes words and/or a picture the person uploaded, and checks them like a comment", async () => {
      const { owner, people, id } = await room();
      const url = await upload(people[0]);
      const withPicture = await write(people[0], id, { imageUrl: url });
      expect(withPicture.status).toBe(201);
      expect(withPicture.body.message).toMatchObject({ content: "", imageUrl: url });
      for (const body of [{}, { content: "  " }, { content: 5 }, { content: "x".repeat(1001) }, { imageUrl: "https://elsewhere.example/x.png" }, { imageUrl: await upload(owner) }]) {
        expect((await write(people[0], id, body)).status, JSON.stringify(body)).toBe(400);
      }
    });

    it("pages the history, the newest fifty first", async () => {
      const { owner, people, id } = await room();
      const docs = Array.from({ length: 60 }, (_, i) => ({ project: id, author: owner.user.id, content: `m${String(i).padStart(2, "0")}` }));
      await M.ProjectMessage.insertMany(docs);
      const first = await chat(people[0], id);
      expect(first.messages).toHaveLength(50);
      expect(first.hasMore).toBe(true);
      expect(first.messages[0].content).toBe("m10");
      expect(first.messages.at(-1).content).toBe("m59");
      const older = await chat(people[0], id, `?before=${first.messages[0].id}`);
      expect(older.messages.map((m) => m.content)).toEqual(Array.from({ length: 10 }, (_, i) => `m${String(i).padStart(2, "0")}`));
      expect(older.hasMore).toBe(false);
    });

    it("tells the others with one notice that counts up, and reading the chat clears it", async () => {
      const { owner, people, id } = await room(["kai", "liv"]);
      await write(owner, id, { content: "one" });
      await write(owner, id, { content: "two" });
      await write(people[1], id, { content: "three" });
      const kais = await M.Notification.find({ recipient: people[0].user.id, type: "project_message" });
      expect(kais).toHaveLength(1);
      expect(kais[0].payload).toMatchObject({ projectId: id, count: 3, title: NEW.title });
      expect(await M.Notification.countDocuments({ recipient: owner.user.id, type: "project_message" })).toBe(1); // liv's, not their own
      expect((await rooms(people[0]))[0].unread).toBe(3);
      await chat(people[0], id);
      expect((await rooms(people[0]))[0].unread).toBe(0);
      expect((await M.Notification.findOne({ recipient: people[0].user.id, type: "project_message" })).isRead).toBe(true);
    });

    it("leaves out people who blocked each other: no messages from them, no notices to them", async () => {
      const { owner, people, id } = await room(["kai", "liv"]);
      await people[0].agent.post("/api/users/liv/block");
      await write(people[1], id, { content: "from liv" });
      await write(owner, id, { content: "from owner" });
      expect((await chat(people[0], id)).messages.map((m) => m.content)).toEqual(["from owner"]);
      expect((await chat(owner, id)).messages.map((m) => m.content)).toEqual(["from liv", "from owner"]);
      expect(await M.Notification.countDocuments({ recipient: people[0].user.id, type: "project_message", "payload.count": 1 })).toBe(1);
    });

    it("lets a writer, or the owner, take a message away, with its picture", async () => {
      const { owner, people, id } = await room();
      const mine = (await write(people[0], id, { content: "oops", imageUrl: await upload(people[0]) })).body.message;
      const theirs = (await write(owner, id, { content: "owner's" })).body.message;
      expect((await people[0].agent.delete(`/api/projects/${id}/messages/${theirs.id}`)).status).toBe(403);
      expect((await owner.agent.delete(`/api/projects/${id}/messages/${mine.id}`)).status).toBe(204);
      expect(destroyed).toHaveLength(1);
      expect((await people[0].agent.delete(`/api/projects/${id}/messages/${mine.id}`)).status).toBe(404);
    });

    it("limits how fast one person writes", async () => {
      const { people, id } = await room();
      await M.RateLimitHit.insertMany(Array.from({ length: 60 }, () => ({ key: `project-message:${people[0].user.id}`, at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
      expect((await write(people[0], id, { content: "too fast" })).status).toBe(429);
    });
  });

  describe("the checklist", () => {
    it("lets members add, tick off, change and remove things, and the owner remove anyone's", async () => {
      const { owner, call, people } = await setup("kai", "liv");
      const id = (await choose(owner, call, people[0])).body.application.projectId;
      await choose(owner, call, people[1]);
      const task = (await people[0].agent.post(`/api/projects/${id}/tasks`).send({ text: "  Send the stems " })).body.task;
      expect(task).toMatchObject({ text: "Send the stems", done: false });
      const ticked = await people[1].agent.patch(`/api/projects/${id}/tasks/${task.id}`).send({ done: true });
      expect(ticked.body.task).toMatchObject({ done: true });
      expect(String(ticked.body.task.doneBy)).toBe(people[1].user.id);
      expect((await people[1].agent.patch(`/api/projects/${id}/tasks/${task.id}`).send({ text: "Send the final stems" })).body.task.text).toBe("Send the final stems");
      expect((await owner.agent.get(`/api/projects/${id}`)).body.project.tasks.map((t) => [t.text, t.done])).toEqual([["Send the final stems", true]]);
      expect((await people[1].agent.delete(`/api/projects/${id}/tasks/${task.id}`)).status).toBe(403); // not theirs, and not the owner
      expect((await owner.agent.delete(`/api/projects/${id}/tasks/${task.id}`)).status).toBe(204);
    });

    it("checks what is written, and stops at forty things", async () => {
      const { owner, call, people } = await setup("kai");
      const id = (await choose(owner, call, people[0])).body.application.projectId;
      const add = (body) => owner.agent.post(`/api/projects/${id}/tasks`).send(body);
      for (const body of [{}, { text: "  " }, { text: 5 }, { text: "x".repeat(121) }]) expect((await add(body)).status, JSON.stringify(body)).toBe(400);
      await M.ProjectTask.insertMany(Array.from({ length: 40 }, (_, i) => ({ project: id, text: `t${i}`, createdBy: owner.user.id })));
      const full = await add({ text: "one more" });
      expect(full.status).toBe(409);
      expect(full.body.error).toMatch(/up to 40/);
      const t = (await M.ProjectTask.findOne({ project: id }))._id;
      for (const body of [{}, { done: "yes" }, { text: "" }]) expect((await owner.agent.patch(`/api/projects/${id}/tasks/${t}`).send(body)).status, JSON.stringify(body)).toBe(400);
    });
  });

  describe("looking after the room", () => {
    it("lets the owner rename it and archive it, after which nothing new can be written but it can still be read", async () => {
      const { owner, call, people } = await setup("kai");
      const id = (await choose(owner, call, people[0])).body.application.projectId;
      await write(people[0], id, { content: "before" });
      expect((await owner.agent.patch(`/api/projects/${id}`).send({ title: "  EP sessions " })).body.project.title).toBe("EP sessions");
      expect((await owner.agent.patch(`/api/projects/${id}`).send({ status: "archived" })).body.project.status).toBe("archived");
      const refused = await write(people[0], id, { content: "after" });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("This project is archived");
      expect((await people[0].agent.post(`/api/projects/${id}/tasks`).send({ text: "x" })).status).toBe(409);
      expect((await chat(people[0], id)).messages).toHaveLength(1);
      expect((await owner.agent.patch(`/api/projects/${id}`).send({ status: "active" })).body.project.status).toBe("active");
      expect((await write(people[0], id, { content: "after" })).status).toBe(201);
    });

    it("refuses bad changes, and changes by anyone but the owner", async () => {
      const { owner, call, people } = await setup("kai");
      const id = (await choose(owner, call, people[0])).body.application.projectId;
      for (const body of [{}, { title: "" }, { title: "x".repeat(81) }, { status: "paused" }]) expect((await owner.agent.patch(`/api/projects/${id}`).send(body)).status, JSON.stringify(body)).toBe(400);
      expect((await people[0].agent.patch(`/api/projects/${id}`).send({ title: "Mine" })).status).toBe(404);
      expect((await people[0].agent.delete(`/api/projects/${id}`)).status).toBe(404);
    });

    it("lets a member leave (their words stay) and the owner remove someone, but the owner can't leave", async () => {
      const { owner, call, people } = await setup("kai", "liv");
      const id = (await choose(owner, call, people[0])).body.application.projectId;
      await choose(owner, call, people[1]);
      await write(people[0], id, { content: "my last words" });
      expect((await owner.agent.post(`/api/projects/${id}/leave`)).status).toBe(400);
      expect((await people[0].agent.post(`/api/projects/${id}/leave`)).status).toBe(204);
      expect(await rooms(people[0])).toEqual([]);
      expect((await people[0].agent.get(`/api/projects/${id}`)).status).toBe(404);
      expect((await chat(owner, id)).messages.map((m) => m.content)).toEqual(["my last words"]);
      expect((await people[1].agent.delete(`/api/projects/${id}/members/${owner.user.id}`)).status).toBe(404);
      expect((await owner.agent.delete(`/api/projects/${id}/members/${owner.user.id}`)).status).toBe(400);
      expect((await owner.agent.delete(`/api/projects/${id}/members/${people[1].user.id}`)).status).toBe(204);
      expect((await people[1].agent.get(`/api/projects/${id}`)).status).toBe(404);
      expect((await owner.agent.delete(`/api/projects/${id}/members/${people[1].user.id}`)).status).toBe(404);
    });

    it("deletes a room with its chat, pictures, checklist and notices", async () => {
      const { owner, call, people } = await setup("kai");
      const id = (await choose(owner, call, people[0])).body.application.projectId;
      await write(owner, id, { content: "with picture", imageUrl: await upload(owner) });
      await owner.agent.post(`/api/projects/${id}/tasks`).send({ text: "a thing" });
      expect((await owner.agent.delete(`/api/projects/${id}`)).status).toBe(204);
      expect(await M.Project.countDocuments({})).toBe(0);
      expect(await M.ProjectMessage.countDocuments({})).toBe(0);
      expect(await M.ProjectTask.countDocuments({})).toBe(0);
      expect(await M.Notification.countDocuments({ type: "project_message" })).toBe(0);
      expect(destroyed).toHaveLength(1);
    });
  });

  describe("reporting a message", () => {
    it("lets a member report a message, shows it to a moderator, and lets them remove it; a stranger gets the missing-thing answer", async () => {
      const { owner, call, people } = await setup("kai");
      const id = (await choose(owner, call, people[0])).body.application.projectId;
      const message = (await write(people[0], id, { content: "A rude message" })).body.message;
      const stranger = await signup(app, "stranger");
      const report = (who) => who.agent.post("/api/reports").send({ targetType: "projectMessage", targetId: message.id, reason: "Rude" });
      expect((await report(stranger)).status).toBe(404);
      expect((await report(owner)).status).toBe(201);
      const boss = await signup(app, "boss");
      await M.User.updateOne({ _id: boss.user.id }, { $set: { emailVerified: true } });
      const cases = (await boss.agent.get("/api/admin/reports")).body.cases;
      expect(cases[0].target).toMatchObject({ text: "A rude message", link: `/projects/${id}` });
      const removed = await boss.agent.post("/api/admin/reports/resolve").send({ targetType: "projectMessage", targetId: message.id, action: "remove" });
      expect(removed.status).toBe(200);
      expect(await M.ProjectMessage.countDocuments({})).toBe(0);
    });
  });

  describe("tidying up", () => {
    it("takes a person's rooms and words away with their account, and deletes rooms they own", async () => {
      const { owner, call, people } = await setup("kai");
      const id = (await choose(owner, call, people[0])).body.application.projectId;
      await write(people[0], id, { content: "from kai" });
      await write(owner, id, { content: "from owner" });
      const data = JSON.parse((await people[0].agent.post("/api/profiles/me/export").send({ password: "password123" })).text);
      expect(data.projects).toMatchObject([{ id, title: NEW.title, role: "member" }]);
      expect(data.projectMessages.map((m) => m.text)).toEqual(["from kai"]);
      expect((await people[0].agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect((await chat(owner, id)).messages.map((m) => m.content)).toEqual(["from owner"]);
      expect((await M.Project.findById(id)).members.map(String)).toEqual([owner.user.id]);
      expect((await owner.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await M.Project.countDocuments({})).toBe(0);
      expect(await M.ProjectMessage.countDocuments({})).toBe(0);
    });
  });
});
