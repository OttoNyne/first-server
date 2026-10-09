import mongoose from "mongoose";

// Someone's answer to an open call: a few words and/or one of their own portfolio pieces. The call's owner chooses them or passes, with a
// short note the applicant sees. One application per person per call.
const callApplicationSchema = new mongoose.Schema(
  {
    call: { type: mongoose.Schema.Types.ObjectId, ref: "Call", required: true },
    applicant: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    note: { type: String, default: "", maxlength: 500 },
    piece: { type: mongoose.Schema.Types.ObjectId, ref: "MediaItem", default: null },
    status: { type: String, enum: ["waiting", "chosen", "passed"], default: "waiting" },
    reply: { type: String, default: "", maxlength: 300 },
    answeredAt: { type: Date, default: null },
  },
  { timestamps: true }
);

callApplicationSchema.index({ call: 1, applicant: 1 }, { unique: true });
callApplicationSchema.index({ applicant: 1, _id: -1 });

export const CallApplication = mongoose.model("CallApplication", callApplicationSchema);
