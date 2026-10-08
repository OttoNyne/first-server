// "npm run test:local": the whole backend test suite against a MongoDB on this computer. Anything after the command goes to Vitest, for example
//   npm run test:local -- tests/auth.test.js
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, LOCAL_MONGO: "1" } });
child.on("exit", (code) => process.exit(code ?? 1));
