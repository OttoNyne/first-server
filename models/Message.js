import mongoose from "mongoose";

export const MAX_MESSAGE_LENGTH = 2000;

const messageSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // "<smaller id>:<larger id>" -- one stable key per pair of people, so a
    // whole conversation is a single indexed lookup.
    pair: { type: String, required: true },
    body: { type: String, required: true, maxlength: MAX_MESSAGE_LENGTH },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

messageSchema.index({ pair: 1, createdAt: -1 });
messageSchema.index({ recipient: 1, readAt: 1 });

export function pairKey(idA, idB) {
  const [a, b] = [String(idA), String(idB)].sort();
  return `${a}:${b}`;
}

export const Message = mongoose.model("Message", messageSchema);
