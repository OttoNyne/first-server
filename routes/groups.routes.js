import { Router } from "express";
import { Group } from "../models/Group.js";
import { GroupMembership } from "../models/GroupMembership.js";
import { requireAuth } from "../middleware/auth.js";
import { toPublicUser } from "../utils/serialize.js";

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

async function withMemberInfo(groups, viewerId) {
  const counts = await GroupMembership.aggregate([
    { $match: { group: { $in: groups.map((g) => g._id) } } },
    { $group: { _id: "$group", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

  const memberships = await GroupMembership.find({
    group: { $in: groups.map((g) => g._id) },
    user: viewerId,
  });
  const memberSet = new Set(memberships.map((m) => String(m.group)));

  return groups.map((g) => ({
    id: g._id,
    name: g.name,
    description: g.description,
    bannerUrl: g.bannerUrl,
    createdById: g.createdBy,
    createdAt: g.createdAt,
    memberCount: countMap.get(String(g._id)) || 0,
    isMember: memberSet.has(String(g._id)),
  }));
}

groupsRouter.get("/", async (req, res) => {
  const filter = req.query.search
    ? { name: { $regex: req.query.search, $options: "i" } }
    : {};
  const groups = await Group.find(filter).sort("-createdAt");
  res.json({ groups: await withMemberInfo(groups, req.user.id) });
});

groupsRouter.post("/", async (req, res) => {
  const group = await Group.create({
    name: req.body.name,
    description: req.body.description,
    bannerUrl: req.body.bannerUrl,
    createdBy: req.user.id,
  });
  await GroupMembership.create({ group: group._id, user: req.user.id, role: "admin" });
  const [withInfo] = await withMemberInfo([group], req.user.id);
  res.status(201).json({ group: withInfo });
});

groupsRouter.get("/:id", async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const [withInfo] = await withMemberInfo([group], req.user.id);
  res.json({ group: withInfo });
});

groupsRouter.post("/:id/join", async (req, res) => {
  const group = await Group.findById(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const existing = await GroupMembership.findOne({ group: group._id, user: req.user.id });
  if (existing) return res.status(409).json({ error: "Already a member" });
  await GroupMembership.create({ group: group._id, user: req.user.id, role: "member" });
  res.status(204).end();
});

groupsRouter.post("/:id/leave", async (req, res) => {
  await GroupMembership.deleteOne({ group: req.params.id, user: req.user.id });
  res.status(204).end();
});

groupsRouter.get("/:id/members", async (req, res) => {
  const members = await GroupMembership.find({ group: req.params.id }).populate("user");
  res.json({
    members: await Promise.all(
      members.map(async (m) => ({
        role: m.role,
        joinedAt: m.joinedAt,
        user: await toPublicUser(m.user, req.user.id),
      }))
    ),
  });
});
