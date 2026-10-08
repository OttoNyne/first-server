import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { PUSH_KINDS, pushBody } from "../utils/pushText.js";
import { describePush } from "../services/push.js";
import { LANGUAGES } from "../utils/languages.js";
import { MockAIProvider } from "../services/ai/MockAIProvider.js";
import { CloudflareAIProvider } from "../services/ai/CloudflareAIProvider.js";

const PARAMS = { who: "WHO_ZED", count: 3, mark: "❤️" };

describe("what a push notification says, in each language", () => {
  it.each(PUSH_KINDS)("%s has words in English, Spanish and Arabic that name who did it", (kind) => {
    const english = pushBody(kind, "en", PARAMS);
    for (const lang of LANGUAGES) {
      const text = pushBody(kind, lang, PARAMS);
      expect(text.trim()).not.toBe("");
      expect(text).not.toMatch(/undefined|\{|\[object/);
      if (english.includes("WHO_ZED")) expect(text, `${kind} in ${lang}`).toContain("WHO_ZED");
      if (english.includes("❤️")) expect(text).toContain("❤️");
      if (lang !== "en") expect(text).not.toBe(english);
    }
  });

  it("leaves the English exactly as it was, and uses the right plural for messages", () => {
    expect(pushBody("message", "en", { who: "Zoe", count: 1 })).toBe("Zoe sent you a message");
    expect(pushBody("message", "en", { who: "Zoe", count: 5 })).toBe("Zoe sent you 5 messages");
    expect(pushBody("message", "es", { who: "Zoe", count: 5 })).toBe("Zoe te envió 5 mensajes");
    expect(pushBody("message", "ar", { who: "Zoe", count: 2 })).toBe("Zoe أرسل إليك رسالتين");
    expect(pushBody("message", "ar", { who: "Zoe", count: 5 })).toBe("Zoe أرسل إليك 5 رسائل");
    expect(pushBody("message", "ar", { who: "Zoe", count: 11 })).toBe("Zoe أرسل إليك 11 رسالة");
  });

  it("is in the language of the person who receives it, never of the one who caused it", () => {
    const note = { type: "comment", payload: { postId: "p1" } };
    const actor = { username: "ann", displayName: "Ann", language: "ar" };
    expect(describePush(note, actor, { username: "bob", language: "es" }).body).toBe("Ann comentó tu publicación");
    expect(describePush(note, actor, { username: "bob" }).body).toBe("Ann commented on your post");
    expect(describePush(note, actor, { username: "bob", language: "klingon" }).body).toBe("Ann commented on your post");
    expect(describePush(note, null, { username: "bob", language: "ar" }).body).toMatch(/^شخص ما/);
  });
});

describe("text the AI writes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is made in the person's language by the built-in provider", async () => {
    const mock = new MockAIProvider();
    const es = (await mock.generateText({ prompt: "pintura", kind: "caption", language: "es" })).text;
    const ar = (await mock.generateText({ prompt: "الرسم", kind: "bio", language: "ar" })).text;
    const en = (await mock.generateText({ prompt: "painting", kind: "caption" })).text;
    expect(es).toMatch(/pintura/);
    expect(es).toMatch(/momento|pensar|🔥/);
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(en).toMatch(/painting/);
    expect(en).not.toMatch(/[؀-ۿ]/);
  }, 15000);

  it("is asked for in that language by the real provider, and English adds nothing", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ result: { response: "Hola" } }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const provider = new CloudflareAIProvider({ accountId: "a", apiToken: "t", model: "m" });
    await provider.generateText({ prompt: "x", kind: "bio", language: "es" });
    await provider.generateText({ prompt: "x", kind: "bio", language: "ar" });
    await provider.generateText({ prompt: "x", kind: "bio" });
    const system = (i) => calls[i].messages[0].content;
    expect(system(0)).toContain("Write it in Spanish.");
    expect(system(1)).toContain("Write it in Arabic.");
    expect(system(2)).not.toMatch(/Write it in/);
  });
});

describe("the language of AI text over the API", () => {
  let app;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  it("comes from the account, not from the request", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email: "mia@example.com", username: "mia", password: "password123", displayName: "Mia", language: "ar" });
    const asked = await agent.post("/api/ai/text").send({ prompt: "الرسم", kind: "bio", language: "es" });
    expect(asked.status).toBe(200);
    expect(asked.body.text).toMatch(/[؀-ۿ]/);
  }, 15000);
});

describe("the data export", () => {
  let app;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  it("describes itself in the account's language, and keeps its field names", async () => {
    const { buildExport } = await import("../services/dataExport.js");
    const { User } = await import("../models/User.js");
    const make = async (username, language) => {
      const res = await request(app).post("/api/auth/register").send({ email: `${username}@example.com`, username, password: "password123", displayName: username, language });
      return res.body.user.id;
    };
    const en = await buildExport(await make("exen", "en"));
    const es = await buildExport(await make("exes", "es"));
    const ar = await buildExport(await make("exar", "ar"));
    expect(en.about).toMatch(/^Everything you have written/);
    expect(es.about).toMatch(/^Todo lo que has escrito/);
    expect(ar.about).toMatch(/[؀-ۿ]/);
    for (const file of [en, es, ar]) expect(Object.keys(file)).toEqual(expect.arrayContaining(["format", "exportedAt", "about", "account"]));
    expect(await User.countDocuments()).toBe(3);
  }, 20000);
});
