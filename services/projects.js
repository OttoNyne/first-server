import { Project } from "../models/Project.js";
import { ProjectMessage } from "../models/ProjectMessage.js";
import { ProjectTask } from "../models/ProjectTask.js";
import { Notification } from "../models/Notification.js";
import { releasePictures } from "./commentPictures.js";

export const MAX_MEMBERS = 8;

const isMember = (project, userId) => project.members.some((m) => String(m) === String(userId));

/**
 * The project room for a call, made the first time someone is chosen, with the person added to it. `{ project }`, or `{ full: true }` when
 * the room already has as many people as it can hold (nothing is changed then).
 */
export async function ensureProject(call, personId) {
  let project = await Project.findOne({ call: call._id });
  if (!project) {
    try {
      project = await Project.create({ call: call._id, owner: call.owner, members: [call.owner, personId], title: call.title });
      return { project };
    } catch (err) {
      if (err?.code !== 11000) throw err; // two choices at once made it first
      project = await Project.findOne({ call: call._id });
    }
  }
  if (isMember(project, personId)) return { project };
  if (project.members.length >= MAX_MEMBERS) return { full: true, project };
  project.members.push(personId);
  await project.save();
  return { project };
}

/** Whether choosing this person would fail because the room has no space left (and the call already has one). */
export async function roomIsFull(call, personId) {
  const project = await Project.findOne({ call: call._id }).select("members");
  return Boolean(project && !isMember(project, personId) && project.members.length >= MAX_MEMBERS);
}

/** A project room and everything in it: messages (and their pictures), the checklist and the notices about it. */
export async function deleteProject(project) {
  const messages = await ProjectMessage.find({ project: project._id, imageUrl: { $ne: null } });
  await ProjectMessage.deleteMany({ project: project._id });
  await releasePictures(messages);
  await ProjectTask.deleteMany({ project: project._id });
  await Notification.deleteMany({ type: "project_message", "payload.projectId": String(project._id) });
  await project.deleteOne();
}

/** Takes one person out of a room (what they wrote stays, as a record of the project) and clears the notices for them about it. */
export async function removeMember(project, personId) {
  await Notification.deleteMany({ recipient: personId, type: "project_message", "payload.projectId": String(project._id) });
  await Project.updateOne({ _id: project._id }, { $pull: { members: personId, reads: { user: personId } } });
  await ProjectTask.updateMany({ project: project._id, doneBy: personId }, { $set: { doneBy: null } });
}
