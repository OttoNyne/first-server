import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// A project room: a small private space for the people who are going to make something together. One is made for an open call the first time
// its owner chooses someone; every person they choose is added to it. It has a chat, a short checklist, and an owner who can archive it.
const projectSchema = new mongoose.Schema(
  {
    // the call it came from (the room outlives the call: taking the call down does not close the room)
    call: { type: ObjectId, ref: "Call", default: null },
    owner: { type: ObjectId, ref: "User", required: true },
    members: { type: [{ type: ObjectId, ref: "User" }], default: [] },
    title: { type: String, required: true, maxlength: 80 },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    lastActivityAt: { type: Date, default: Date.now },
    // when each member last opened the chat, so what is new for them can be counted
    reads: { type: [{ _id: false, user: { type: ObjectId, ref: "User" }, at: { type: Date } }], default: [] },
  },
  { timestamps: true }
);

projectSchema.index({ members: 1, lastActivityAt: -1 });
projectSchema.index({ call: 1 }, { unique: true, partialFilterExpression: { call: { $type: "objectId" } } });

export const Project = mongoose.model("Project", projectSchema);
