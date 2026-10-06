import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Keeps a secret that must be read back later (the two-step sign-in secret) unreadable in the database: AES-256-GCM, with a key
// made from the site's own JWT_SECRET, so a copy of the database alone doesn't give anyone the means to make codes. (A password is
// different: it is only ever checked, so it is hashed instead.) Anything changed in storage fails to open rather than opening wrongly.
const key = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return Buffer.from(hkdfSync("sha256", secret, "creativesselect", "two-step-secret", 32));
};

export function seal(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function open(sealed) {
  const [iv, tag, body] = String(sealed).split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !body || iv.length !== 12 || tag.length !== 16) throw new Error("Not a sealed secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
