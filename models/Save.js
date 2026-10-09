import mongoose from "mongoose";

// A post or portfolio piece someone saved to look at again. Private to the person who saved it: nobody else can see what is in their list.
const saveSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    targetType: { type: String, enum: ["post", "piece"], required: true },
    target: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

saveSchema.index({ user: 1, targetType: 1, target: 1 }, { unique: true });
saveSchema.index({ user: 1, targetType: 1, _id: -1 });
saveSchema.index({ target: 1 });

export const Save = mongoose.model("Save", saveSchema);
