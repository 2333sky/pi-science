/** Check the real source-worker path before short-deadline Windows IPC tests. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const serverRequire = createRequire(new URL("../apps/server/package.json", import.meta.url));
await import(pathToFileURL(serverRequire.resolve("tsx")).href);
const { AgentCoreRuntimeClient } = await import("../apps/server/src/runtime/agent/agent-runtime-client.ts");
const root = await mkdtemp(join(tmpdir(), "pi-worker-startup-"));
const previousHome = process.env.PI_SCIENCE_HOME;
process.env.PI_SCIENCE_HOME = join(root, "private");
const elapsed = [];
try {
  for (let index = 0; index < 3; index++) {
    const cwd = join(root, `workspace-${index}`);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    const start = performance.now();
    const client = await AgentCoreRuntimeClient.start({ cwd, sessionsRoot: join(cwd, ".pi-science", "agent-sessions"),
      model: { provider: "openai", modelId: "gpt-4.1-mini" }, allowedTools: [] }, 30_000);
    elapsed.push(Math.round(performance.now() - start));
    await client.shutdown();
    console.log(JSON.stringify({ attempt: index + 1, initializeMs: elapsed.at(-1) }));
  }
  if (elapsed.slice(1).some((milliseconds) => milliseconds >= 5_000)) {
    throw new Error(`Warm worker startup exceeds the existing 5s IPC deadline: ${elapsed.join(", ")}ms`);
  }
} finally {
  if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
