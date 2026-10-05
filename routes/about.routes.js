import { Router } from "express";
import { User } from "../models/User.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { getProfileForViewer, areFriends } from "../utils/visibility.js";
import { ABOUT_FIELDS, checkAbout } from "../utils/about.js";
import { allowEdit } from "../utils/textInput.js";

// The About me part of a profile, kept apart from the user record the lists use so a long list of people doesn't carry every
// person's answers. Reading follows the profile's own visibility; the place and the birthday are shared only as the owner chose.
export const aboutRouter = Router();

/** What the viewer may see of someone's About me. The owner sees everything, with the settings; a friend sees the birthday too. */
async function shape(user, viewerId) {
  const isOwner = String(user._id) === String(viewerId);
  const isFriend = !isOwner && viewerId ? await areFriends(viewerId, user._id) : false;
  const about = Object.fromEntries(ABOUT_FIELDS.map((field) => [field, user.about?.[field] ?? ""]));
  const location = user.location ?? "";
  const showLocation = Boolean(location) && (isOwner || user.locationAudience === "everyone" || isFriend);
  return {
    about,
    location: showLocation ? location : "",
    birthday: (isOwner || isFriend) && user.birthday?.month ? { month: user.birthday.month, day: user.birthday.day } : null,
    // only for the owner: who may see the place
    ...(isOwner ? { locationAudience: user.locationAudience ?? "friends" } : {}),
  };
}

aboutRouter.get("/:username", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(String(req.params.username).toLowerCase(), req.user?.id);
    res.json(await shape(user, req.user?.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Change your own: any of the fields. "" clears a text field, and { birthday: null } stops sharing the birthday (it is forgotten).
aboutRouter.put("/me", requireAuth, async (req, res) => {
  const checked = checkAbout(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!(await allowEdit(req, res))) return;
  const user = await User.findById(req.user.id);
  const { birthday, location, locationAudience, ...text } = checked.value;
  for (const [field, value] of Object.entries(text)) user.set(`about.${field}`, value);
  if (location !== undefined) user.location = location;
  if (locationAudience !== undefined) user.locationAudience = locationAudience;
  if (birthday !== undefined) user.birthday = birthday ?? undefined;
  await user.save();
  res.json(await shape(user, req.user.id));
});
