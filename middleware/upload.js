import crypto from "crypto";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { isStorageUnavailable, logStorageProblem, STORAGE_UNAVAILABLE_MESSAGE } from "../utils/storageErrors.js";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_PURPOSES = ["avatars", "wallpapers", "portfolio", "tracks"];

const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const PURPOSE_MIME = {
  avatars: IMAGE_MIME,
  wallpapers: [...IMAGE_MIME, "video/mp4", "video/webm"],
  // Portfolio videos: the 30-second limit is enforced after upload (the
  // duration is only known once Cloudinary has the file) — see routes/media.
  portfolio: [...IMAGE_MIME, "video/mp4", "video/webm", "video/quicktime"],
  tracks: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"],
};

function purposeFor(req) {
  return ALLOWED_PURPOSES.includes(req.query.purpose) ? req.query.purpose : "portfolio";
}

// Cloudinary rejects a file over its plan limit (10 MB for images on the free
// plan) with an SDK error. Left alone that surfaces as a generic 500; turn it
// into a clear 413, and any other storage failure into a 502.
function toUploadError(err) {
  const tooLarge = /too large/i.test(err?.message ?? "");
  const unavailable = !tooLarge && isStorageUnavailable(err);
  const out = new Error(
    tooLarge
      ? "That file is too large to upload — images can be up to 10 MB."
      : unavailable
        ? STORAGE_UNAVAILABLE_MESSAGE
        : "Couldn't store that file, please try again."
  );
  out.name = "UploadRejected";
  out.status = tooLarge ? 413 : unavailable ? 503 : 502;
  if (!tooLarge) logStorageProblem("upload", err);
  return out;
}

// A minimal multer StorageEngine implementation (just _handleFile/_removeFile)
// instead of the `multer-storage-cloudinary` package — its latest release
// pins a peer dependency on cloudinary@^1.x, which conflicts with the
// cloudinary@^2.7.0 we need for a patched high-severity advisory in <2.7.0.
// The v2 SDK still exposes the same uploader.upload_stream API this uses.
class CloudinaryStorage {
  _handleFile(req, file, cb) {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `creativeselect/${purposeFor(req)}`,
        resource_type: "auto",
        public_id: crypto.randomUUID(),
      },
      (err, result) => {
        if (err) return cb(toUploadError(err));
        cb(null, { path: result.secure_url, filename: result.public_id, size: result.bytes, duration: result.duration });
      }
    );
    file.stream.pipe(uploadStream);
  }

  _removeFile(req, file, cb) {
    cloudinary.uploader.destroy(file.filename, { invalidate: true }, () => cb(null));
  }
}

const storage = new CloudinaryStorage();

function fileFilter(req, file, cb) {
  const allowed = PURPOSE_MIME[purposeFor(req)] || IMAGE_MIME;
  cb(null, allowed.includes(file.mimetype));
}

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 30 * 1024 * 1024 },
});
