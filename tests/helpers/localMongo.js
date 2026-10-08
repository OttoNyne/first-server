// Runs the tests against a MongoDB server of their own on this computer instead of the shared cloud one, when LOCAL_MONGO is set (see
// scripts/test-local.mjs). The cloud database is ~0.5 to 1 second away on a bad day, which turns a 5-minute run into an hour; a local one
// answers in a millisecond. Without LOCAL_MONGO nothing changes (this is how CI runs too: its own MongoDB container is already local).
//
// The first run downloads the MongoDB server program once (into the user's cache folder); after that it starts in about a second.
export async function setup() {
  if (!process.env.LOCAL_MONGO) return undefined;
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  const server = await MongoMemoryServer.create({ binary: { version: process.env.LOCAL_MONGO_VERSION || "7.0.14" }, instance: { dbName: "creativeselect_test" } });
  // The test helpers read MONGODB_URI (dotenv never replaces a value that is already set), and pick the database name themselves.
  process.env.MONGODB_URI = server.getUri();
  console.log("Tests are using a local MongoDB (not the cloud one).");
  return async () => {
    await server.stop();
  };
}
