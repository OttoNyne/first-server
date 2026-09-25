export function errorHandler(err, req, res, next) {
  // A malformed id in a URL param (e.g. not a valid ObjectId) is a client
  // mistake, not a server fault — every :id route across the app relies on
  // this instead of validating the format itself, so this is the one place
  // that needs to draw that line.
  if (err.name === "CastError") {
    return res.status(400).json({ error: "Invalid id" });
  }
  // A missing/invalid required field caught by the Mongoose schema itself
  // (routes that pass req.body straight to .create()/.save() without their
  // own validation, e.g. group creation) is a client mistake too — same
  // reasoning as CastError above.
  if (err.name === "ValidationError") {
    const firstError = Object.values(err.errors)[0];
    return res.status(400).json({ error: firstError?.message || "Validation failed" });
  }
  // Upload storage (Cloudinary) rejected the file or was unavailable — the
  // message was written for the user (see toUploadError in upload.js).
  if (err.name === "UploadRejected") {
    return res.status(err.status).json({ error: err.message });
  }
  // Multer rejects an oversized/malformed upload by calling next(err) itself
  // — same reasoning as CastError above, a client mistake, not a server one.
  if (err.name === "MulterError") {
    const message =
      err.code === "LIMIT_FILE_SIZE" ? "File exceeds the 30MB upload limit" : err.message;
    return res.status(413).json({ error: message });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
