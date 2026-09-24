import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, required: true, trim: true },
    bio: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    wallpaperUrl: { type: String, default: null },
    wallpaperType: { type: String, enum: ["image", "video"], default: "image" },
    wallpaperPosition: { type: String, default: "50% 50%" },
    isPrivate: { type: Boolean, default: false },
    // Sessions (JWTs) issued before this moment are rejected — set when the
    // password changes so old/stolen sessions stop working.
    passwordChangedAt: { type: Date, default: null },
    theme: {
      bgColor: String,
      textColor: String,
      accentColor: String,
      fontFamily: String,
      layoutStyle: String,
    },
  },
  { timestamps: true }
);

// Not a real field on the model — set only transiently by the auth service
// (register/login) to carry a plaintext password through to this hook.
userSchema.virtual("password").set(function (value) {
  this._plainPassword = value;
});

userSchema.pre("validate", async function () {
  if (!this._plainPassword) return;
  this.passwordHash = await bcrypt.hash(this._plainPassword, 12);
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

// The account email is private to its owner: it's only included when the
// caller says the viewer is the user themselves (see toPublicUser).
userSchema.methods.toPublic = function ({ includeEmail = false } = {}) {
  return {
    id: this._id,
    ...(includeEmail ? { email: this.email } : {}),
    username: this.username,
    displayName: this.displayName,
    bio: this.bio,
    avatarUrl: this.avatarUrl,
    wallpaperUrl: this.wallpaperUrl,
    wallpaperType: this.wallpaperType,
    wallpaperPosition: this.wallpaperPosition,
    isPrivate: this.isPrivate,
    createdAt: this.createdAt,
    theme: this.theme || {},
  };
};

// Minimal identity shape for a viewer who isn't the owner and isn't an
// accepted friend of a private user — omits everything that counts as
// profile *content* (bio, wallpaper, theme) or personal info (email).
userSchema.methods.toPublicRestricted = function () {
  return {
    id: this._id,
    username: this.username,
    displayName: this.displayName,
    avatarUrl: this.avatarUrl,
    isPrivate: this.isPrivate,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model("User", userSchema);
