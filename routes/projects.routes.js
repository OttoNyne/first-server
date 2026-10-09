import { Router } from "express";
import mongoose from "mongoose";
import { Project } from "../models/Project.js";
import { ProjectMessage } from "../models/ProjectMessage.js";
import { ProjectTask } from "../models/ProjectTask.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { cleanLine } from "../utils/profileFields.js";
import { checkComment } from "../utils/commentInput.js";
import { cursorFilter } from "../utils/textInput.js";
import { blockedUserIds } from "../utils/visibility.js";
import { releasePictures } from "../services/commentPictures.js";
import { publish } from "../services/liveUpdates.js";
import { deleteProject, removeMember } from "../services/projects.js";

// Project rooms: a small private space for the people making something together, made when an open call's owner chooses someone. A chat, a
// short checklist, and an owner who can rename, archive, remove people or delete it. Only members can see anything in it; for anyone else a
// room is the same 404 as one that doesn't exist.
export const projectsRouter = Router();
projectsRouter.use(requireAuth);

export const MAX_MESSAGE = 1000;
export const MAX_TASKS = 40;
export const MAX_TASK = 120;
const PAGE = 50;
const messageLimit = createLimiter({ name: "project-message", limit: 60, windowMs: 10 * 60 * 1000 });
const taskLimit = createLimiter({ name: "project-task", limit: 60, windowMs: 60 * 60 * 1000 });
const bad = (res, error, status = 400) => res.status(status).json({ error });
const missing = (res) => bad(res, "Project not found", 404);
const validId = (id) => mongoose.isValidObjectId(id);
const person = (u) => ({ id: u._id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl ?? null, csVerified: Boolean(u.csVerifiedByAdmin || u.csVerifiedEarned) });
const PEOPLE = "username displayName avatarUrl csVerifiedByAdmin csVerifiedEarned suspendedAt";

/** The room, if this person is in it; otherwise null (the same answer as a missing room). */
async function mine(id, userId) {
  if (!validId(id)) return null;
  const project = await Project.findById(id);
  return project && project.members.some((m) => String(m) === String(userId)) ? project : null;
}

const tellAll = (project, extra = {}) => project.members.forEach((m) => publish(m, "project", { id: String(project._id), ...extra }));

const toPublicMessage = (m, author, viewerId) => ({ id: m._id, content: m.content, imageUrl: m.imageUrl ?? null, createdAt: m.createdAt, mine: String(author?._id ?? m.author) === String(viewerId), author: author ? person(author) : null });
const toPublicTask = (t) => ({ id: t._id, text: t.text, done: t.done, doneBy: t.doneBy ?? null, createdBy: t.createdBy ?? null, createdAt: t.createdAt });

async function toPublicProject(project, viewerId, extra = {}) {
  const members = await User.find({ _id: { $in: project.members } }).select(PEOPLE);
  const order = new Map(project.members.map((m, i) => [String(m), i]));
  members.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
  return {
    id: project._id,
    callId: project.call ?? null,
    title: project.title,
    status: project.status,
    lastActivityAt: project.lastActivityAt,
    owner: String(project.owner),
    isOwner: String(project.owner) === String(viewerId),
    members: members.map((u) => ({ ...person(u), isOwner: String(u._id) === String(project.owner) })),
    ...extra,
  };
}

async function markRead(project, userId) {
  const now = new Date();
  const updated = await Project.updateOne({ _id: project._id, "reads.user": userId }, { $set: { "reads.$.at": now } });
  if (!updated.matchedCount) await Project.updateOne({ _id: project._id }, { $push: { reads: { user: userId, at: now } } });
  await Notification.updateMany({ recipient: userId, type: "project_message", "payload.projectId": String(project._id) }, { $set: { isRead: true } });
}

// One notice per room while it is unread, counting up, so a busy chat can't flood anyone's bell. People who have blocked the writer, or the
// other way round, aren't told.
async function notifyMembers(project, author) {
  try {
    const blocked = await blockedUserIds(author);
    for (const member of project.members) {
      if (String(member) === String(author) || blocked.has(String(member))) continue;
      const where = { recipient: member, type: "project_message", isRead: false, "payload.projectId": String(project._id) };
      const previous = await Notification.findOne(where);
      if (previous) await previous.deleteOne();
      await Notification.create({ recipient: member, type: "project_message", payload: { actorId: String(author), projectId: String(project._id), title: project.title, count: (previous?.payload?.count ?? 0) + 1 } });
    }
  } catch (err) {
    console.error("Couldn't notify a project room:", err.message);
  }
}

// Your rooms, the most recently active first, with how much is new for you and how many things are still to do.
projectsRouter.get("/", async (req, res) => {
  const rooms = await Project.find({ members: req.user.id }).sort({ lastActivityAt: -1 }).limit(50);
  const out = [];
  for (const project of rooms) {
    const readAt = project.reads.find((r) => String(r.user) === req.user.id)?.at ?? new Date(0);
    const [unread, openTasks] = await Promise.all([ProjectMessage.countDocuments({ project: project._id, author: { $ne: req.user.id }, createdAt: { $gt: readAt } }), ProjectTask.countDocuments({ project: project._id, done: false })]);
    out.push(await toPublicProject(project, req.user.id, { unread, openTasks }));
  }
  res.json({ projects: out });
});

// One room with its checklist.
projectsRouter.get("/:id", async (req, res) => {
  const project = await mine(req.params.id, req.user.id);
  if (!project) return missing(res);
  const tasks = await ProjectTask.find({ project: project._id }).sort({ _id: 1 });
  res.json({ project: await toPublicProject(project, req.user.id, { tasks: tasks.map(toPublicTask) }) });
});

// Change the room (the owner): its name, or archive it / bring it back.
projectsRouter.patch("/:id", async (req, res) => {
  const project = await mine(req.params.id, req.user.id);
  if (!project || String(project.owner) !== req.user.id) return missing(res);
  if (req.body && Object.hasOwn(req.body, "title")) {
    const title = typeof req.body.title === "string" ? cleanLine(req.body.title) : "";
    if (!title) return bad(res, "Give the project a name");
    if ([...title].length > 80) return bad(res, "Names can be up to 80 characters");
    project.title = title;
  }
  if (req.body && Object.hasOwn(req.body, "status")) {
    if (!["active", "archived"].includes(req.body.status)) return bad(res, "Status must be active or archived");
    project.status = req.body.status;
  }
  if (!project.isModified()) return bad(res, "Nothing to change");
  await project.save();
  tellAll(project);
  res.json({ project: await toPublicProject(project, req.user.id) });
});

// Delete the room for everyone (the owner), with its chat and checklist.
projectsRouter.delete("/:id", async (req, res) => {
  const project = await mine(req.params.id, req.user.id);
  if (!project || String(project.owner) !== req.user.id) return missing(res);
  const members = [...project.members];
  await deleteProject(project);
  members.forEach((m) => publish(m, "project", { id: String(project._id), gone: true }));
  res.status(204).end();
});

// Leave a room (anyone but the owner, who archives or deletes it instead).
projectsRouter.post("/:id/leave", async (req, res) => {
  const project = await mine(req.params.id, req.user.id);
  if (!project) return missing(res);
  if (String(project.owner) === req.user.id) return bad(res, "The owner can archive or delete the project instead", 400);
  await removeMember(project, req.user.id);
  tellAll(project);
  publish(req.user.id, "project", { id: String(project._id), gone: true });
  res.status(204).end();
});

// Take someone out of the room (the owner).
projectsRouter.delete("/:id/members/:userId", async (req, res) => {
  const project = await mine(req.params.id, req.user.id);
  if (!project || String(project.owner) !== req.user.id) return missing(res);
  if (!validId(req.params.userId) || !project.members.some((m) => String(m) === req.params.userId)) return bad(res, "That person isn't in this project", 404);
  if (req.params.userId === req.user.id) return bad(res, "The owner can't be removed");
  await removeMember(project, req.params.userId);
  publish(req.params.userId, "project", { id: String(project._id), gone: true });
  tellAll(project);
  res.status(204).end();
});

// The chat: the newest 50, oldest first (?before=<message id> for older ones). Reading it marks the room read. Anyone you have blocked, or who
// blocked you, is left out.
projectsRouter.get("/:id/messages", async (req, res) => {
  const project = await mine(req.params.id, req.user.id);
  if (!project) return missing(res);
  const filter = { project: project._id, author: { $nin: [...(await blockedUserIds(req.user.id))] } };
  const before = cursorFilter(req.query, mongoose);
  if (before) filter._id = { $lt: before };
  const found = await ProjectMessage.find(filter).sort({ _id: -1 }).limit(PAGE + 1).populate("author", PEOPLE);
  const page = found.slice(0, PAGE).reverse();
  if (!before) await markRead(project, req.user.id);
  res.json({ messages: page.map((m) => toPublicMessage(m, m.author, req.user.id)), hasMore: found.length > PAGE });
});

// Write in the chat: `{ content?, imageUrl? }` (words and/or a picture you uploaded; up to 1000 characters and 3 links).
projectsRouter.post("/:id/messages", async (req, res) => {
  const project = await mine(req.params.id, req.user.id);
  if (!project) return missing(res);
  if (project.status === "archived") return bad(res, "This project is archived", 409);
  const checked = await checkComment(req.body, { userId: req.user.id, max: MAX_MESSAGE, label: "Messages" });
  if (checked.error) return bad(res, checked.error);
  if (!(await messageLimit.allow(req.user.id))) {
    res.set("Retry-After", String(messageLimit.windowSeconds));
    return bad(res, "You're writing too fast — try again in a few minutes.", 429);
  }
  const message = await ProjectMessage.create({ project: project._id, author: req.user.id, content: checked.value.content, imageUrl: checked.value.imageUrl ?? null });
  project.lastActivityAt = new Date();
  await project.save();
  await markRead(project, req.user.id);
  await notifyMembers(project, req.user.id);
  tellAll(project);
  const author = await User.findById(req.user.id).select(PEOPLE);
  res.status(201).json({ message: toPublicMessage(message, author, req.user.id) });
});

// Take a message away: its writer, or the owner of the room.
projectsRouter.delete("/:id/messages/:messageId", async (req, res) => {
  const project = await mine(req.params.id, req.user.id);
  if (!project) return missing(res);
  const message = validId(req.params.messageId) ? await ProjectMessage.findOne({ _id: req.params.messageId, project: project._id }) : null;
  if (!message) return bad(res, "Message not found", 404);
  if (String(message.author) !== req.user.id && String(project.owner) !== req.user.id) return bad(res, "Not allowed", 403);
  await message.deleteOne();
  await releasePictures([message]);
  tellAll(project);
  res.status(204).end();
});

// The checklist: add a line (any member), tick it off or change it (any member), take it away (who added it, or the owner).
projectsRouter.post("/:id/tasks", async (req, res) => {
  const project = await mine(req.params.id, req.user.id);
  if (!project) return missing(res);
  if (project.status === "archived") return bad(res, "This project is archived", 409);
  const text = typeof req.body?.text === "string" ? cleanLine(req.body.text) : "";
  if (!text) return bad(res, "Write what needs doing");
  if ([...text].length > MAX_TASK) return bad(res, `A task can be up to ${MAX_TASK} characters`);
  if ((await ProjectTask.countDocuments({ project: project._id })) >= MAX_TASKS) return bad(res, `A checklist can have up to ${MAX_TASKS} things`, 409);
  if (!(await taskLimit.allow(req.user.id))) return bad(res, "You're adding things too fast — try again in a bit", 429);
  const task = await ProjectTask.create({ project: project._id, text, createdBy: req.user.id });
  project.lastActivityAt = new Date();
  await project.save();
  tellAll(project);
  res.status(201).json({ task: toPublicTask(task) });
});

projectsRouter.patch("/:id/tasks/:taskId", async (req, res) => {
  const project = await mine(req.params.id, req.user.id);
  if (!project) return missing(res);
  if (project.status === "archived") return bad(res, "This project is archived", 409);
  const task = validId(req.params.taskId) ? await ProjectTask.findOne({ _id: req.params.taskId, project: project._id }) : null;
  if (!task) return bad(res, "Task not found", 404);
  if (req.body && Object.hasOwn(req.body, "done")) {
    if (typeof req.body.done !== "boolean") return bad(res, "done must be true or false");
    task.done = req.body.done;
    task.doneBy = req.body.done ? req.user.id : null;
  }
  if (req.body && Object.hasOwn(req.body, "text")) {
    const text = typeof req.body.text === "string" ? cleanLine(req.body.text) : "";
    if (!text) return bad(res, "Write what needs doing");
    if ([...text].length > MAX_TASK) return bad(res, `A task can be up to ${MAX_TASK} characters`);
    task.text = text;
  }
  if (!task.isModified()) return bad(res, "Nothing to change");
  await task.save();
  tellAll(project);
  res.json({ task: toPublicTask(task) });
});

projectsRouter.delete("/:id/tasks/:taskId", async (req, res) => {
  const project = await mine(req.params.id, req.user.id);
  if (!project) return missing(res);
  const task = validId(req.params.taskId) ? await ProjectTask.findOne({ _id: req.params.taskId, project: project._id }) : null;
  if (!task) return bad(res, "Task not found", 404);
  if (String(task.createdBy) !== req.user.id && String(project.owner) !== req.user.id) return bad(res, "Not allowed", 403);
  await task.deleteOne();
  tellAll(project);
  res.status(204).end();
});

