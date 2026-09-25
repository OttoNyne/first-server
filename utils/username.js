import { z } from "zod";

// Usernames appear in URLs (/u/:username), so keep them URL-safe: letters,
// digits and underscores only. (Stored lowercased by the User schema.)
export const USERNAME_MESSAGE = "Username must be 3–30 characters: letters, numbers and underscores only";

export const usernameSchema = z
  .string()
  .trim()
  .min(3, USERNAME_MESSAGE)
  .max(30, USERNAME_MESSAGE)
  .regex(/^[a-zA-Z0-9_]+$/, USERNAME_MESSAGE);

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Display name can't be empty")
  .max(80, "Display name must be 80 characters or fewer");
