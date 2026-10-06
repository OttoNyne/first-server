import { describe, it, expect, beforeAll } from "vitest";
import { base32Decode, base32Encode, codeForStep, generateRecoveryCodes, generateSecret, hashRecoveryCode, looksLikeRecoveryCode, matchStep, normalizeRecoveryCode, otpauthUrl, stepAt } from "../utils/totp.js";
import { open, seal } from "../utils/secretBox.js";

// The test secret and times from RFC 6238, Appendix B (SHA-1): the codes every authenticator app must agree with.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const RFC_VECTORS = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

describe("base32", () => {
  it("round-trips, and matches the RFC 4648 examples", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    for (let length = 0; length < 30; length++) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + length) % 256));
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  it("reads lower case and padding, and refuses anything that isn't base32", () => {
    expect(base32Decode("mzxw6ytboi======").toString()).toBe("foobar");
    expect(() => base32Decode("MZXW6YT!")).toThrow();
    expect(() => base32Decode("MZXW1YTB")).toThrow(); // 1 isn't in the alphabet
  });
});

describe("one-time codes", () => {
  it.each(RFC_VECTORS)("gives the RFC 6238 code for time %i", (seconds, code) => {
    expect(codeForStep(RFC_SECRET, Math.floor(seconds / 30))).toBe(code);
  });

  it("makes a new random secret of the usual size each time", () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(generateSecret()).not.toBe(a);
  });

  it("accepts the current code and one step either side, and nothing further away", () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(matchStep(RFC_SECRET, codeForStep(RFC_SECRET, step), { now })).toBe(step);
    expect(matchStep(RFC_SECRET, codeForStep(RFC_SECRET, step - 1), { now })).toBe(step - 1);
    expect(matchStep(RFC_SECRET, codeForStep(RFC_SECRET, step + 1), { now })).toBe(step + 1);
    expect(matchStep(RFC_SECRET, codeForStep(RFC_SECRET, step - 2), { now })).toBeNull();
    expect(matchStep(RFC_SECRET, codeForStep(RFC_SECRET, step + 2), { now })).toBeNull();
  });

  it("refuses anything that isn't six digits, before looking at the secret", () => {
    const now = 1_700_000_000_000;
    const good = codeForStep(RFC_SECRET, stepAt(now));
    for (const bad of ["", "12345", "1234567", "12345a", " " + good, good + " ", good.split("").join(" "), null, undefined, 123456, ["123456"], { code: good }]) {
      expect(matchStep(RFC_SECRET, bad, { now }), String(bad)).toBeNull();
    }
  });

  it("is for the secret it was made from, and no other", () => {
    const now = 1_700_000_000_000;
    expect(matchStep(generateSecret(), codeForStep(RFC_SECRET, stepAt(now)), { now })).toBeNull();
  });

  it("makes the address an authenticator app takes, with the account and issuer safely encoded", () => {
    const url = otpauthUrl({ secret: RFC_SECRET, account: "zoe+art@example.com", issuer: "Creatives Select" });
    expect(url).toBe(`otpauth://totp/Creatives%20Select:zoe%2Bart%40example.com?secret=${RFC_SECRET}&issuer=Creatives%20Select&algorithm=SHA1&digits=6&period=30`);
  });
});

describe("recovery codes", () => {
  it("makes eight different single-use codes of ten characters, without look-alikes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      expect(code).not.toMatch(/[ilo01]/);
      expect(looksLikeRecoveryCode(code)).toBe(true);
    }
  });

  it("forgives capitals, spaces and a missing dash, and hashes them all alike", () => {
    const [code] = generateRecoveryCodes(1);
    const variants = [code, code.toUpperCase(), code.replace("-", ""), ` ${code.replace("-", " ")} `, code.toUpperCase().replace("-", "")];
    for (const v of variants) {
      expect(normalizeRecoveryCode(v)).toBe(code.replace("-", ""));
      expect(hashRecoveryCode(v)).toBe(hashRecoveryCode(code));
      expect(looksLikeRecoveryCode(v)).toBe(true);
    }
    expect(hashRecoveryCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(code)).not.toBe(hashRecoveryCode(generateRecoveryCodes(1)[0]));
  });

  it("doesn't take a six-digit code, text of the wrong length, or non-text for one", () => {
    for (const bad of ["123456", "abcde-fghjk-m", "short", "", null, undefined, 1234567890, ["abcdefghjk"], "abcde fghj!"]) {
      expect(looksLikeRecoveryCode(bad), String(bad)).toBe(false);
    }
  });
});

describe("the sealed secret", () => {
  beforeAll(() => {
    process.env.JWT_SECRET ??= "test-secret";
  });

  it("opens to what was put in, and the stored text doesn't show it", () => {
    const sealed = seal(RFC_SECRET);
    expect(sealed).not.toContain(RFC_SECRET);
    expect(sealed.split(".")).toHaveLength(3);
    expect(open(sealed)).toBe(RFC_SECRET);
  });

  it("is different every time it is sealed", () => {
    expect(seal(RFC_SECRET)).not.toBe(seal(RFC_SECRET));
  });

  it("refuses anything that was changed, cut short or made up", () => {
    const [iv, tag, body] = seal(RFC_SECRET).split(".");
    const flip = (b64) => Buffer.from(b64, "base64").map((x, i) => (i === 0 ? x ^ 1 : x)).toString("base64");
    expect(() => open([iv, tag, flip(body)].join("."))).toThrow();
    expect(() => open([iv, flip(tag), body].join("."))).toThrow();
    expect(() => open([flip(iv), tag, body].join("."))).toThrow();
    expect(() => open([iv, tag].join("."))).toThrow();
    expect(() => open("")).toThrow();
    expect(() => open("a.b.c")).toThrow();
  });

  it("can't be opened with a different site secret", () => {
    const sealed = seal(RFC_SECRET);
    const before = process.env.JWT_SECRET;
    process.env.JWT_SECRET = before + "-changed";
    try {
      expect(() => open(sealed)).toThrow();
    } finally {
      process.env.JWT_SECRET = before;
    }
  });
});
