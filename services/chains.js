import { Chain } from "../models/Chain.js";
import { ChainSection } from "../models/ChainSection.js";
import { Notification } from "../models/Notification.js";

export const CHAIN_PARTS = 3;
export const SECTION_WIDTH = 1200;
export const SECTION_HEIGHT = 400;
export const EDGE_HEIGHT = 40;
export const MAX_SECTION_BYTES = 500 * 1024;
export const MAX_EDGE_BYTES = 100 * 1024;
export const CLAIM_MINUTES = 30;
export const MAX_OPEN_OWN = 3;
export const MAX_PROMPT = 100;

/** Takes a chain away with all its parts and the notices about it (a report about it then shows as already gone, like any other deleted thing). */
export async function deleteChain(chainId) {
  await ChainSection.deleteMany({ chain: chainId });
  await Notification.deleteMany({ type: "chain_done", "payload.chainId": String(chainId) });
  await Chain.deleteOne({ _id: chainId });
}

/** Everything that goes when a person's account does: every chain they drew a part of (a part can't be taken out of a chain and leave it whole),
 *  and any claim they were holding. */
export async function removeChainsOf(userId) {
  for (const chain of await Chain.find({ contributors: userId }).select("_id")) await deleteChain(chain._id);
  await Chain.updateMany({ claimUser: userId }, { $set: { claimUser: null, claimUntil: null } });
}
