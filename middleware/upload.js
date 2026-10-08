import crypto from "crypto";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { isStorageUnavailable, logStorageProblem, STORAGE_UNAVAILABLE_MESSAGE } from "../utils/storageErrors.js";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_PURPOSES = ["avatars", "wallpapers", "portfolio", "tracks", "comments"];

const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const PURPOSE_MIME = {
  avatars: IMAGE_MIME,
  // A picture (or GIF) to put in a comment: stored here like any other upload, never linked from somewhere else.
  comments: IMAGE_MIME,
  wallpapers: [...IMAGE_MIME, "video/mp4", "video/webm"],
  // Portfolio videos: the length limit (a minute) is enforced after upload (the
  // duration is only known once Cloudinary has the file) — see routes/media.
  portfolio: [...IMAGE_MIME, "video/mp4", "video/webm", "video/quicktime"],
  // iPhones label their audio differently from other devices: a .m4a from Voice Memos or Files
  // arrives as audio/x-m4a (or audio/m4a, audio/aac), and a .wav as audio/x-wav. All are accepted.
  tracks: [
    "audio/mpeg", "audio/mp3",
    "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/x-aac",
    "audio/wav", "audio/x-wav", "audio/wave",
    "audio/ogg", "audio/webm",
  ],
};

function purposeFor(req) {
  return ALLOWED_PURPOSES.includes(req.query.purpose) ? req.query.purpose : "portfolio";
}

// How big a file may be. A minute of phone video is much bigger than a picture (an iPhone records about 130 MB a minute at 1080p, a phone
// in its "smaller file" setting about a third of that), so video gets room up to the storage plan's own per-file limit, and everything
// else keeps the lower one. A file over its limit is cut off as it arrives, so it never fills the server's memory or the storage.
export const UPLOAD_LIMITS = { video: 100 * 1024 * 1024, other: 30 * 1024 * 1024 };
const isVideoType = (mimetype) => String(mimetype).startsWith("video/");
const limitFor = (mimetype) => (isVideoType(mimetype) ? UPLOAD_LIMITS.video : UPLOAD_LIMITS.other);

const sizeMessage = (isVideo) => (isVideo ? `That video is too large — videos can be up to ${Math.round(UPLOAD_LIMITS.video / 1024 / 1024)} MB. Try a lower-quality setting, or trim it.` : "That file is too large to upload — images can be up to 10 MB.");

// Cloudinary rejects a file over its plan limit (10 MB for images on the free
// plan) with an SDK error. Left alone that surfaces as a generic 500; turn it
// into a clear 413, and any other storage failure into a 502.
function toUploadError(err, isVideo = false) {
  const tooLarge = /too large/i.test(err?.message ?? "");
  const unavailable = !tooLarge && isStorageUnavailable(err);
  const out = new Error(
    tooLarge
      ? sizeMessage(isVideo)
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
    const isVideo = isVideoType(file.mimetype);
    const cap = limitFor(file.mimetype);
    let finished = false;
    const finish = (err, info) => {
      if (finished) return;
      finished = true;
      cb(err, info);
    };
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `creativeselect/${purposeFor(req)}`,
        resource_type: "auto",
        public_id: crypto.randomUUID(),
      },
      (err, result) => {
        if (err) return finish(toUploadError(err, isVideo));
        finish(null, { path: result.secure_url, filename: result.public_id, size: result.bytes, duration: result.duration });
      }
    );
    // Count what arrives; past the limit, stop sending it on, abandon the upload and refuse the file.
    let seen = 0;
    file.stream.on("data", (chunk) => {
      seen += chunk.length;
      if (seen > cap && !finished) {
        file.stream.unpipe(uploadStream);
        uploadStream.destroy();
        file.stream.resume(); // read and drop the rest, so the request can finish and be answered
        const err = new Error(sizeMessage(isVideo));
        err.name = "UploadRejected";
        err.status = 413;
        finish(err);
      }
    });
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
  // The most any file may be (video); the lower limit for everything else is applied as the file arrives (see CloudinaryStorage).
  limits: { fileSize: UPLOAD_LIMITS.video },
});
