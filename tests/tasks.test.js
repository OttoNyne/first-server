import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

async function registerAndLogin(agent, overrides = {}) {
  const user = {
    email: "owner@example.com",
    username: "owner",
    password: "password123",
    displayName: "Owner",
    ...overrides,
  };
  const res = await agent.post("/api/auth/register").send(user);
  return res.body.user;
}

describe("tasks CRUD", () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    // Loaded dynamically, after loadEnv() — see the comment in auth.test.js.
    ({ app } = await import("../app.js"));
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  it("rejects every task route with no auth", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "x" });
    const list = await request(app).get("/api/tasks");
    expect(create.status).toBe(401);
    expect(list.status).toBe(401);
  });

  it("supports full create/read/update/delete for the owner", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent);

    const create = await agent.post("/api/tasks").send({ title: "Write tests" });
    expect(create.status).toBe(201);
    expect(create.body.title).toBe("Write tests");
    expect(create.body.done).toBe(false);
    const taskId = create.body._id;

    const list = await agent.get("/api/tasks");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const getOne = await agent.get(`/api/tasks/${taskId}`);
    expect(getOne.status).toBe(200);
    expect(getOne.body.title).toBe("Write tests");

    const update = await agent.put(`/api/tasks/${taskId}`).send({ done: true });
    expect(update.status).toBe(200);
    expect(update.body.done).toBe(true);

    const del = await agent.delete(`/api/tasks/${taskId}`);
    expect(del.status).toBe(200);

    const getAfterDelete = await agent.get(`/api/tasks/${taskId}`);
    expect(getAfterDelete.status).toBe(404);
  });

  it("rejects a task with no title", async () => {
    const agent = request.agent(app);
    await registerAndLogin(agent);

    const res = await agent.post("/api/tasks").send({});
    expect(res.status).toBe(400);
  });

  it("never lets a client reassign a task's owner via the update body", async () => {
    const ownerAgent = request.agent(app);
    const owner = await registerAndLogin(ownerAgent);

    const otherAgent = request.agent(app);
    const other = await registerAndLogin(otherAgent, {
      email: "other@example.com",
      username: "other",
    });

    const create = await ownerAgent.post("/api/tasks").send({ title: "Mine" });
    const taskId = create.body._id;

    const attack = await ownerAgent
      .put(`/api/tasks/${taskId}`)
      .send({ owner: other.id, title: "Still mine?" });
    expect(attack.status).toBe(200);
    expect(attack.body.owner).toBe(owner.id);

    // the task must not have moved into the other user's list
    const otherList = await otherAgent.get("/api/tasks");
    expect(otherList.body).toHaveLength(0);
  });

  it("keeps one user's tasks invisible and unreachable to another user", async () => {
    const ownerAgent = request.agent(app);
    await registerAndLogin(ownerAgent);
    const create = await ownerAgent.post("/api/tasks").send({ title: "Private task" });
    const taskId = create.body._id;

    const otherAgent = request.agent(app);
    await registerAndLogin(otherAgent, { email: "stranger@example.com", username: "stranger" });

    const list = await otherAgent.get("/api/tasks");
    expect(list.body).toHaveLength(0);

    const getOne = await otherAgent.get(`/api/tasks/${taskId}`);
    expect(getOne.status).toBe(404);

    const update = await otherAgent.put(`/api/tasks/${taskId}`).send({ done: true });
    expect(update.status).toBe(404);

    const del = await otherAgent.delete(`/api/tasks/${taskId}`);
    expect(del.status).toBe(404);
  });
});
