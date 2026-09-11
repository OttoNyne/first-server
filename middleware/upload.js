import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

const ALLOWED_PURPOSES = ["avatars", "wallpapers", "portfolio", "tracks"];

const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const PURPOSE_MIME = {
  avatars: IMAGE_MIME,
  wallpapers: [...IMAGE_MIME, "video/mp4", "video/webm"],
  portfolio: IMAGE_MIME,
  tracks: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"],
};

export function ensureUploadDirs() {
  for (const folder of [...ALLOWED_PURPOSES, "ai-generated"]) {
    fs.mkdirSync(path.join(UPLOADS_ROOT, folder), { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const purpose = ALLOWED_PURPOSES.includes(req.query.purpose) ? req.query.purpose : "portfolio";
    const dest = path.join(UPLOADS_ROOT, purpose);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename(req, file, cb) {
    cb(null, `${crypto.randomUUID()}${path.extname(file.originalname)}`);
  },
});

function fileFilter(req, file, cb) {
  const purpose = ALLOWED_PURPOSES.includes(req.query.purpose) ? req.query.purpose : "portfolio";
  const allowed = PURPOSE_MIME[purpose] || IMAGE_MIME;
  cb(null, allowed.includes(file.mimetype));
}

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 30 * 1024 * 1024 },
});
