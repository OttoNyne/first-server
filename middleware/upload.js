import crypto from "crypto";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

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
  portfolio: IMAGE_MIME,
  tracks: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"],
};

function purposeFor(req) {
  return ALLOWED_PURPOSES.includes(req.query.purpose) ? req.query.purpose : "portfolio";
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
        if (err) return cb(err);
        cb(null, { path: result.secure_url, filename: result.public_id, size: result.bytes });
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
