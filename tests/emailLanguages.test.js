import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { EMAIL_KINDS, emailFor } from "../utils/emailText.js";
import { isLanguage, languageOf, LANGUAGES } from "../utils/languages.js";

const outbox = [];
vi.mock("../utils/mailer.js", () => ({
  mailAvailable: () => true,
  sendMail: vi.fn(async (mail) => {
    outbox.push(mail);
    return { sent: true };
  }),
}));

// every value a text can be given, each one a word that can't be mistaken for anything else
const PARAMS = { name: "NAME_ZED", link: "https://site.example/x#token=LINKTOKEN", username: "USER_ZED", masked: "m****@example.com", keyName: "KEY_ZED", device: "DEVICE_ZED", when: "WHEN_ZED", removedPasskeys: true,
  // the weekly summary
  followers: 2, activity: 3, requests: 1, roomsUnread: 4, calls: [{ title: "CALL_ZED" }], topics: [{ tag: "tagzed", n: 5 }], site: "https://site.example", topicsLink: "https://site.example/explore?mine=1", callsLink: "https://site.example/calls", roomsLink: "https://site.example/projects", unsubscribe: "https://site.example/digest/unsubscribe#token=UNSUBTOKEN" };

describe("which language an email is in", () => {
  it("knows the site's languages, and treats anything else as English", () => {
    expect(LANGUAGES).toEqual(["en", "es", "ar"]);
    expect(isLanguage("es")).toBe(true);
    expect(isLanguage("fr")).toBe(false);
    expect(languageOf({ language: "ar" })).toBe("ar");
    for (const odd of [null, undefined, {}, { language: "fr" }, { language: "<script>" }, { language: 5 }]) expect(languageOf(odd)).toBe("en");
  });
});

describe("every email, in every language", () => {
  it.each(EMAIL_KINDS)("%s has a subject and text with every value in it, in English, Spanish and Arabic", (kind) => {
    const english = emailFor(kind, "en", PARAMS);
    for (const lang of LANGUAGES) {
      const mail = emailFor(kind, lang, PARAMS);
      expect(mail.subject.trim()).not.toBe("");
      expect(mail.text.trim()).not.toBe("");
      expect(mail.text).not.toMatch(/undefined|\[object|\{[a-z]/i);
      expect(mail.subject).not.toMatch(/undefined|\{/);
      // anything the English email carries (a link, a name, a device), the others carry too
      for (const value of Object.values(PARAMS)) {
        if (typeof value === "string" && english.text.includes(value)) expect(mail.text, `${kind} in ${lang} is missing ${value}`).toContain(value);
      }
      if (lang !== "en") expect(mail.text).not.toBe(english.text);
    }
  });

  it("leaves English exactly as it always was", () => {
    expect(emailFor("verify", "en", PARAMS)).toEqual({
      subject: "Confirm your CreativesSelect email",
      text: "Hi NAME_ZED,\n\nWelcome to CreativesSelect. Please confirm this is your email address by opening this link within 24 hours:\n\nhttps://site.example/x#token=LINKTOKEN\n\nIf you didn't create an account, you can ignore this email.",
    });
  });

  it("mentions removed passkeys only when some were removed", () => {
    for (const lang of LANGUAGES) {
      const withKeys = emailFor("passwordReset", lang, { ...PARAMS, removedPasskeys: 2 }).text;
      const without = emailFor("passwordReset", lang, { ...PARAMS, removedPasskeys: 0 }).text;
      expect(withKeys.length).toBeGreaterThan(without.length);
    }
  });

  it("is in Arabic with the text written right to left and the link left whole", () => {
    const mail = emailFor("resetLink", "ar", PARAMS);
    expect(mail.text).toMatch(/[؀-ۿ]/);
    expect(mail.text).toContain("https://site.example/x#token=LINKTOKEN");
  });

  it("falls back to English for a language it doesn't have", () => {
    expect(emailFor("twoFactorOn", "fr", PARAMS)).toEqual(emailFor("twoFactorOn", "en", PARAMS));
    expect(emailFor("twoFactorOn", { language: "xx" }, PARAMS)).toEqual(emailFor("twoFactorOn", "en", PARAMS));
  });
});

describe("the language an account is emailed in", () => {
  let app;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
  });
  beforeEach(async () => {
    await clearTestDb();
    outbox.length = 0;
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });
  const signup = (body) => request.agent(app).post("/api/auth/register").send({ password: "password123", ...body });
  const arrives = (re) => vi.waitFor(() => expect(outbox.some((m) => re.test(m.subject))).toBe(true), { timeout: 5000 });

  it("is the page's language at sign-up: the confirmation email comes in it, and the account says so", async () => {
    const res = await signup({ email: "rosa@example.com", username: "rosa", displayName: "Rosa", language: "es" });
    expect(res.status).toBe(201);
    expect(res.body.user.language).toBe("es");
    await arrives(/Confirma tu correo/);
    expect(outbox.find((m) => /Confirma/.test(m.subject)).text).toMatch(/Hola, Rosa/);
  });

  it("is English when the page doesn't say, and a made-up language is refused", async () => {
    const plain = await signup({ email: "ann@example.com", username: "ann", displayName: "Ann" });
    expect(plain.body.user.language).toBe("en");
    await arrives(/Confirm your CreativesSelect email/);
    const bad = await signup({ email: "bob@example.com", username: "bob", displayName: "Bob", language: "klingon" });
    expect(bad.status).toBe(400);
  });

  it("can be changed from the profile, and nothing else is accepted", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email: "sam@example.com", username: "sam", password: "password123", displayName: "Sam" });
    const changed = await agent.patch("/api/profiles/me").send({ language: "ar" });
    expect(changed.status).toBe(200);
    expect(changed.body.user.language).toBe("ar");
    expect((await agent.get("/api/auth/me")).body.user.language).toBe("ar");
    for (const bad of ["fr", "", 5, null, { $ne: "en" }]) {
      const res = await agent.patch("/api/profiles/me").send({ language: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await agent.get("/api/auth/me")).body.user.language).toBe("ar");
  });

  it("decides the language of the password-reset email and the one that follows it", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email: "lina@example.com", username: "lina", password: "password123", displayName: "Lina", language: "ar" });
    outbox.length = 0;
    await request(app).post("/api/auth/forgot-password").send({ email: "lina@example.com" });
    await arrives(/إعادة تعيين كلمة مرور/);
    const token = outbox.find((m) => /إعادة تعيين/.test(m.subject)).text.match(/#token=([a-f0-9]+)/)[1];
    outbox.length = 0;
    const reset = await request(app).post("/api/auth/reset-password").send({ token, newPassword: "a-new-password-1" });
    expect(reset.status).toBe(204);
    await arrives(/تم تغيير كلمة مرور/);
  });

  it("is never taken from the request to an email: someone else can't pick the language of another person's mail", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email: "eve@example.com", username: "eve", password: "password123", displayName: "Eve" });
    outbox.length = 0;
    await request(app).post("/api/auth/forgot-password").send({ email: "eve@example.com", language: "ar" });
    await arrives(/Reset your CreativesSelect password/);
  });
});
