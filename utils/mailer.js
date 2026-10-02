import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

// Whether a reset email could actually be delivered. Outside production the fallbacks
// (outbox / printing) count, so local development works with no setup; in production
// it needs a real provider.
export function mailAvailable() {
  if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) return true;
  return process.env.NODE_ENV !== "production";
}

// Sends one plain-text email. Three ways, picked from the environment:
//
//   RESEND_API_KEY (+ MAIL_FROM)  real delivery through Resend's HTTP API
//   MAIL_OUTBOX_DIR               writes each email to a JSON file instead — for
//                                 automated browser tests; ignored in production
//   neither                       nothing is delivered. In development the message
//                                 is printed; in production only a warning is
//                                 logged (the text can hold a reset link).
//
// It never throws: callers send mail in the background and a delivery problem
// must not change what the user sees (that would leak whether an address exists).
export async function sendMail({ to, subject, text }) {
  const isProduction = process.env.NODE_ENV === "production";
  try {
    const key = process.env.RESEND_API_KEY;
    if (key) {
      const from = process.env.MAIL_FROM;
      if (!from) throw new Error("MAIL_FROM is not set");
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { sent: true };
    }

    if (process.env.MAIL_OUTBOX_DIR && !isProduction) {
      await mkdir(process.env.MAIL_OUTBOX_DIR, { recursive: true });
      const file = path.join(process.env.MAIL_OUTBOX_DIR, `${Date.now()}-${randomBytes(4).toString("hex")}.json`);
      await writeFile(file, JSON.stringify({ to, subject, text }, null, 2));
      return { sent: true };
    }

    if (isProduction) {
      console.warn(`MAIL NOT SENT to a user: no mail provider configured (set RESEND_API_KEY and MAIL_FROM). Subject: "${subject}"`);
    } else {
      console.log(`[mail not configured — printing instead]\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`);
    }
    return { sent: false };
  } catch (err) {
    console.error(`MAIL FAILED (subject "${subject}"):`, err.message);
    return { sent: false };
  }
}
