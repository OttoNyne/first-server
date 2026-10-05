import { createLimiter } from "./rateLimit.js";

// Pictures in comments are files we pay to store, so they are smaller than a portfolio piece and limited per person.
export const MAX_COMMENT_PICTURE_BYTES = 5 * 1024 * 1024;
export const commentPictureLimiter = createLimiter({ name: "comment-picture", limit: 20, windowMs: 60 * 60 * 1000 });
