import { createHash, randomBytes } from "node:crypto";
import { EmailVerification } from "../models/EmailVerification.js";
import { sendMail, mailAvailable } from "../utils/mailer.js";
import { primaryClientUrl } from "../utils/origins.js";

const TTL_MS = 24 * 60 * 60 * 1000;
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

// Emails the person a link that confirms they own the address. The token goes in the URL fragment (never sent to
// a server or in a Referer) and is stored only as a hash. Returns whether an email was handed to the mail provider.
export async function sendVerificationEmail(user) {
  if (!mailAvailable()) return false;
  await EmailVerification.deleteMany({ user: user._id }); // only the newest link works
  const token = randomBytes(32).toString("hex");
  await EmailVerification.create({ user: user._id, tokenHash: hashToken(token), expireAt: new Date(Date.now() + TTL_MS) });
  const base = process.env.CLIENT_URL ? primaryClientUrl() : "http://localhost:5173";
  const { sent } = await sendMail({
    to: user.email,
    subject: "Confirm your CreativesSelect email",
    text:
      `Hi ${user.displayName},\n\n` +
      "Welcome to CreativesSelect. Please confirm this is your email address by opening this link within 24 hours:\n\n" +
      `${base}/verify-email#token=${token}\n\n` +
      "If you didn't create an account, you can ignore this email.",
  });
  return sent;
}
