export function errorHandler(err, req, res, next) {
  // A malformed id in a URL param (e.g. not a valid ObjectId) is a client
  // mistake, not a server fault — every :id route across the app relies on
  // this instead of validating the format itself, so this is the one place
  // that needs to draw that line.
  if (err.name === "CastError") {
    return res.status(400).json({ error: "Invalid id" });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
