// How much work hashing a password costs (bcrypt "cost": each step doubles it). In real use it is always 12, which is what makes stolen
// hashes slow to guess at. Tests sign up hundreds of people, and at cost 12 that hashing is most of the time a test run takes, so a test
// run may lower it (BCRYPT_COST, between 4 and 12) to run much faster. It is ignored in production, and anything outside the range
// falls back to 12, so a stray setting can never weaken the real thing.
export const REAL_COST = 12;

export function passwordCost(env = process.env) {
  if (env.NODE_ENV === "production") return REAL_COST;
  const asked = Number(env.BCRYPT_COST);
  return Number.isInteger(asked) && asked >= 4 && asked <= REAL_COST ? asked : REAL_COST;
}
