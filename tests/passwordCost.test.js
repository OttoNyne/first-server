import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import { passwordCost, REAL_COST } from "../utils/passwordCost.js";

describe("passwordCost", () => {
  it("is the real cost unless a test run asks for less", () => {
    expect(REAL_COST).toBe(12);
    expect(passwordCost({ NODE_ENV: "development" })).toBe(12);
    expect(passwordCost({})).toBe(12);
  });

  it("can be lowered outside production, down to 4 and no further", () => {
    for (const cost of [4, 5, 8, 12]) expect(passwordCost({ NODE_ENV: "test", BCRYPT_COST: String(cost) })).toBe(cost);
    for (const bad of ["3", "0", "-4", "13", "31", "abc", "", "4.5", "NaN", "Infinity", " "]) expect(passwordCost({ NODE_ENV: "test", BCRYPT_COST: bad }), bad).toBe(12);
  });

  it("is always the real cost in production, whatever is set", () => {
    for (const cost of ["4", "8", "12", "1"]) expect(passwordCost({ NODE_ENV: "production", BCRYPT_COST: cost })).toBe(12);
  });

  it("makes hashes that really do differ in cost, and both still check out", async () => {
    const cheap = await bcrypt.hash("a-password", passwordCost({ NODE_ENV: "test", BCRYPT_COST: "4" }));
    const real = await bcrypt.hash("a-password", passwordCost({ NODE_ENV: "production" }));
    expect(cheap.startsWith("$2b$04$") || cheap.startsWith("$2a$04$")).toBe(true);
    expect(real.startsWith("$2b$12$") || real.startsWith("$2a$12$")).toBe(true);
    expect(await bcrypt.compare("a-password", cheap)).toBe(true);
    expect(await bcrypt.compare("a-password", real)).toBe(true);
  });

  it("is what the running tests actually use", async () => {
    expect(process.env.BCRYPT_COST).toBe("4");
    expect(passwordCost()).toBe(4);
  });
});
