import mongoose from "mongoose";

// One line on a project room's checklist. Any member can add one and tick it off.
const projectTaskSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    text: { type: String, required: true, maxlength: 120 },
    done: { type: Boolean, default: false },
    doneBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

projectTaskSchema.index({ project: 1, _id: 1 });

export const ProjectTask = mongoose.model("ProjectTask", projectTaskSchema);
