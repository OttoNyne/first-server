import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";

// Time-based one-time codes (RFC 6238, the kind authenticator apps show): six digits that change every 30 seconds, made from a secret
// only the server and the person's app share. Written out here, with Node's own crypto, rather than pulled in as a dependency.
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("Not a base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret (160 bits, as authenticator apps expect), as the base32 text an app takes. */
export const generateSecret = () => base32Encode(randomBytes(20));

/** The code for one 30-second step. */
export function codeForStep(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

const sameText = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Which step this code is for, if any: the current one or the one either side (a phone's clock is rarely exact). Every step is
 * checked either way, so how long it takes doesn't show how close a guess was. null when it matches none.
 */
export function matchStep(secret, code, { now = Date.now(), window = 1 } = {}) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const current = stepAt(now);
  let found = null;
  for (let step = current - window; step <= current + window; step++) {
    if (sameText(codeForStep(secret, step), code) && found === null) found = step;
  }
  return found;
}

/** The address an authenticator app is given (as text, or as a QR code) to add the account. */
export function otpauthUrl({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---- Recovery codes -----------------------------------------------------------
// For a lost phone: single-use, 50 random bits each (so storing only a hash is enough), without look-alike characters.
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const RECOVERY_CODE_COUNT = 8;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

/** What is typed is forgiven for spaces, dashes and capitals; what is stored is only a hash. */
export const normalizeRecoveryCode = (text) => String(text).toLowerCase().replace(/[\s-]/g, "");
export const hashRecoveryCode = (text) => createHash("sha256").update(normalizeRecoveryCode(text)).digest("hex");
export const looksLikeRecoveryCode = (text) => typeof text === "string" && new RegExp(`^[${RECOVERY_ALPHABET}]{10}$`).test(normalizeRecoveryCode(text));
