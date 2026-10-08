import mongoose from "mongoose";

// A request for work: someone asks a person who is "open to work" to make or do something (a commission, a collaboration), with a short
// brief. The person can accept or decline, with a short note that the asker sees. No money passes through the site.
const workRequestSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 80 },
    details: { type: String, required: true, maxlength: 1000 },
    // free text on purpose ("around 200", "to be agreed"): it is only a hint, and nothing is charged
    budget: { type: String, default: "", maxlength: 40 },
    deadline: { type: Date, default: null },
    status: { type: String, enum: ["open", "accepted", "declined"], default: "open" },
    // what the person answered with, shown to the asker
    reply: { type: String, default: "", maxlength: 500 },
    answeredAt: { type: Date, default: null },
  },
  { timestamps: true }
);

workRequestSchema.index({ to: 1, status: 1, createdAt: -1 });
workRequestSchema.index({ from: 1, createdAt: -1 });

export const WorkRequest = mongoose.model("WorkRequest", workRequestSchema);
