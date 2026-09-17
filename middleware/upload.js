import crypto from "crypto";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";

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

const storage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => ({
    folder: `creativeselect/${purposeFor(req)}`,
    resource_type: "auto",
    public_id: crypto.randomUUID(),
  }),
});

function fileFilter(req, file, cb) {
  const allowed = PURPOSE_MIME[purposeFor(req)] || IMAGE_MIME;
  cb(null, allowed.includes(file.mimetype));
}

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 30 * 1024 * 1024 },
});
