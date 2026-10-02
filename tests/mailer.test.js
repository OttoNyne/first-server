import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mailAvailable, sendMail } from "../utils/mailer.js";

const mail = { to: "ada@example.com", subject: "Hello", text: "Body with a secret link" };
const saved = { ...process.env };

beforeEach(() => {
  for (const k of ["RESEND_API_KEY", "MAIL_FROM", "MAIL_OUTBOX_DIR"]) delete process.env[k];
  process.env.NODE_ENV = "test";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe("sendMail", () => {
  it("delivers through Resend when a key and sender are set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.MAIL_FROM = "CreativesSelect <noreply@example.com>";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendMail(mail)).toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    expect(JSON.parse(init.body)).toEqual({ from: "CreativesSelect <noreply@example.com>", to: ["ada@example.com"], subject: "Hello", text: mail.text });
  });

  it("reports a failure instead of throwing when the provider refuses, without logging the message body", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.MAIL_FROM = "noreply@example.com";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("domain not verified", { status: 403 })));
    expect(await sendMail(mail)).toEqual({ sent: false });
    const logged = console.error.mock.calls.flat().join(" ");
    expect(logged).toMatch(/403/);
    expect(logged).not.toMatch(/secret link/);
  });

  it("doesn't throw when the network is down or MAIL_FROM is missing", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(await sendMail(mail)).toEqual({ sent: false }); // no MAIL_FROM
    process.env.MAIL_FROM = "noreply@example.com";
    expect(await sendMail(mail)).toEqual({ sent: false }); // network error
  });

  it("writes to an outbox folder outside production (for browser tests)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "outbox-"));
    process.env.MAIL_OUTBOX_DIR = dir;
    try {
      expect(await sendMail(mail)).toEqual({ sent: true });
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      expect(JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))).toEqual(mail);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores the outbox in production and never prints the message there", async () => {
    process.env.NODE_ENV = "production";
    process.env.MAIL_OUTBOX_DIR = path.join(tmpdir(), "should-not-be-created");
    expect(await sendMail(mail)).toEqual({ sent: false });
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn.mock.calls.flat().join(" ")).not.toMatch(/secret link/);
    expect(console.warn.mock.calls.flat().join(" ")).toMatch(/no mail provider configured/);
  });

  it("prints the message in development when nothing is configured", async () => {
    expect(await sendMail(mail)).toEqual({ sent: false });
    expect(console.log.mock.calls.flat().join(" ")).toMatch(/secret link/);
  });
});

describe("mailAvailable", () => {
  it("is true in development with no setup, and in production only with a provider", () => {
    expect(mailAvailable()).toBe(true);
    process.env.NODE_ENV = "production";
    expect(mailAvailable()).toBe(false);
    process.env.RESEND_API_KEY = "k";
    expect(mailAvailable()).toBe(false); // needs a sender too
    process.env.MAIL_FROM = "noreply@example.com";
    expect(mailAvailable()).toBe(true);
  });
});
