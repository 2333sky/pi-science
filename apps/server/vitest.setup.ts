import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = dirname(fileURLToPath(new URL("./package.json", import.meta.url)));
const workerBundle = join(serverRoot, "node_modules", ".cache", "pi-science-worker", "entry", "main.mjs");

// Runs inside each test worker, where the global setup's environment is not
// visible. Without a bundle (a single `vitest run <file>` still runs setup),
// the worker fork falls back to the tsx entry exactly as before.
if (existsSync(workerBundle)) process.env.PI_SCIENCE_WORKER_ENTRY = workerBundle;
