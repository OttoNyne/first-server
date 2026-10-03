import { afterEach, describe, expect, it } from "vitest";
import { clientOrigins, isAllowedOrigin, primaryClientUrl } from "../utils/origins.js";

const saved = process.env.CLIENT_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.CLIENT_URL;
  else process.env.CLIENT_URL = saved;
});

describe("CLIENT_URL origins", () => {
  it("is one address, tidied up", () => {
    process.env.CLIENT_URL = "https://app.example.com/";
    expect(clientOrigins()).toEqual(["https://app.example.com"]);
    expect(primaryClientUrl()).toBe("https://app.example.com");
  });

  it("can list several, separated by commas, ignoring spaces, trailing slashes and empties", () => {
    process.env.CLIENT_URL = " https://www.example.com/ ,https://my-app.vercel.app,, ";
    expect(clientOrigins()).toEqual(["https://www.example.com", "https://my-app.vercel.app"]);
  });

  it("treats the first as the primary address (used for links in emails)", () => {
    process.env.CLIENT_URL = "https://www.example.com,https://my-app.vercel.app";
    expect(primaryClientUrl()).toBe("https://www.example.com");
  });

  it("falls back to local development when unset or blank", () => {
    delete process.env.CLIENT_URL;
    expect(clientOrigins()).toEqual(["http://localhost:3000"]);
    process.env.CLIENT_URL = " , ";
    expect(clientOrigins()).toEqual(["http://localhost:3000"]);
  });

  it("matches origins exactly: scheme, host and port all count", () => {
    process.env.CLIENT_URL = "https://www.example.com,http://localhost:5173";
    expect(isAllowedOrigin("https://www.example.com")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    for (const no of ["https://example.com", "http://www.example.com", "https://www.example.com:444", "https://www.example.com.evil.net", "null", "", undefined]) {
      expect(isAllowedOrigin(no)).toBe(false);
    }
  });
});
