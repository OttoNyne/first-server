import mongoose from "mongoose";

// One message in a project room's chat: words and/or a picture the author uploaded. Only the room's members can read it.
const projectMessageSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, default: "", maxlength: 1000 },
    imageUrl: { type: String, default: null },
  },
  { timestamps: true }
);

projectMessageSchema.index({ project: 1, _id: -1 });
projectMessageSchema.index({ author: 1 });

export const ProjectMessage = mongoose.model("ProjectMessage", projectMessageSchema);
