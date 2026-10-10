import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

describe("agreeing to the terms at sign-up", () => {
  let app, User, TERMS_VERSION;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ User } = await import("../models/User.js"));
    ({ TERMS_VERSION } = await import("../utils/terms.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const register = (name, extra = {}) =>
    request(app)
      .post("/api/auth/register")
      .set("x-vercel-forwarded-for", `198.51.129.${Math.floor(Math.random() * 250) + 1}`)
      .send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name, ...extra });

  it("records when, and to which version of the pages, the person agreed", async () => {
    const before = Date.now();
    const res = await register("agreed", { acceptedTerms: true });
    expect(res.status).toBe(201);
    const user = await User.findOne({ username: "agreed" });
    expect(user.termsVersion).toBe(TERMS_VERSION);
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(user.termsAcceptedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(user.termsAcceptedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("records nothing for an account made without it (an older client), and anything but true counts as no", async () => {
    expect((await register("older")).status).toBe(201);
    const older = await User.findOne({ username: "older" });
    expect(older.termsAcceptedAt).toBeNull();
    expect(older.termsVersion).toBeNull();
    // a value that isn't a real yes is refused by the form's own checks, and makes no account
    expect((await register("sneaky", { acceptedTerms: "yes" })).status).toBe(400);
    expect(await User.countDocuments({ username: "sneaky" })).toBe(0);
  });

  it("is in the person's own data download", async () => {
    const agent = request.agent(app);
    await agent
      .post("/api/auth/register")
      .set("x-vercel-forwarded-for", "198.51.129.251")
      .send({ email: "exp@example.com", username: "exporter", password: "password123", displayName: "exporter", acceptedTerms: true });
    const exported = JSON.parse((await agent.post("/api/profiles/me/export").send({ password: "password123" })).text);
    expect(exported.account.termsVersion).toBe(TERMS_VERSION);
    expect(typeof exported.account.termsAcceptedAt).toBe("string");
  });
});
