import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../app.js";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

describe("auth", () => {
  beforeAll(async () => {
    await connectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const credentials = {
    email: "test-user@example.com",
    username: "testuser",
    password: "password123",
    displayName: "Test User",
  };

  it("registers a new user and never returns the password", async () => {
    const res = await request(app).post("/api/auth/register").send(credentials);

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(credentials.email);
    expect(res.body.user.username).toBe(credentials.username);
    expect(res.body.user).not.toHaveProperty("password");
    expect(res.body.user).not.toHaveProperty("passwordHash");
  });

  it("rejects registering the same email twice", async () => {
    await request(app).post("/api/auth/register").send(credentials);
    const res = await request(app).post("/api/auth/register").send(credentials);

    expect(res.status).toBe(409);
  });

  it("logs in with correct credentials and sets a session cookie", async () => {
    await request(app).post("/api/auth/register").send(credentials);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: credentials.email, password: credentials.password });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(credentials.email);
    expect(res.headers["set-cookie"][0]).toMatch(/^token=/);
  });

  it("rejects login with the wrong password", async () => {
    await request(app).post("/api/auth/register").send(credentials);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: credentials.email, password: "wrong-password" });

    expect(res.status).toBe(401);
  });

  it("rejects a protected route with no token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("rejects a protected route with a tampered token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Cookie", ["token=not.a.valid.jwt"]);
    expect(res.status).toBe(401);
  });

  it("accepts a protected route with a valid session", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send(credentials);
    const res = await agent.get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(credentials.username);
  });
});
