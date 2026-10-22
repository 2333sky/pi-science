/** Exercise the real production worker before short-deadline Windows IPC tests. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { flushCompileCache } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentCoreRuntimeClient, workerEnvironment } from "../apps/server/dist/runtime/agent/agent-runtime-client.js";

const root = await mkdtemp(join(tmpdir(), "pi-worker-startup-"));
const previousHome = process.env.PI_SCIENCE_HOME;
process.env.PI_SCIENCE_HOME = join(root, "private");
const elapsed = [];
process.env.PI_SCIENCE_AGENT_STARTUP_TRACE = "1";
const originalEmit = AgentCoreRuntimeClient.prototype.emit;
AgentCoreRuntimeClient.prototype.emit = function (name, ...args) {
  if (name === "stderr") process.stderr.write(String(args[0]));
  return originalEmit.call(this, name, ...args);
};
try {
  // Make the parent's module cache available to the first child as well.
  flushCompileCache();
  const moduleUrl = new URL(process.env.PI_SCIENCE_AGENT_WORKER_MODE === "bundled"
    ? "../apps/server/dist/runtime/agent/worker/main.test-bundle.mjs" : "../apps/server/dist/runtime/agent/worker/main.js", import.meta.url).href;
  const probeCode = `const start=performance.now(); const cpu=process.cpuUsage(); await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify({phase:'module-load',elapsedMs:Math.round(performance.now()-start),cpu:process.cpuUsage(cpu)}));`;
  const probe = async (env, timeout = 4_000) => {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", probeCode], { timeout, env, killSignal: "SIGKILL" });
      return JSON.parse(stdout.trim().split("\n").at(-1)).elapsedMs;
    } catch { return Infinity; }
  };
  const controlled = workerEnvironment();
  const moduleMs = await probe(controlled, 30_000);
  console.log(JSON.stringify({ phase: "controlled-module-load", elapsedMs: moduleMs }));
  if (moduleMs >= 4_000 && await probe(process.env) < 4_000) {
    const names = new Map(Object.entries(controlled).map(([key, value]) => [key.toLowerCase(), value]));
    let suspects = Object.keys(process.env).filter((key) => names.get(key.toLowerCase()) !== process.env[key]);
    let partitions = 2, probes = 0;
    while (suspects.length > 1 && probes < 24) {
      let reduced = false;
      const size = Math.ceil(suspects.length / partitions);
      for (let start = 0; start < suspects.length && probes++ < 24; start += size) {
        const remaining = suspects.filter((_, index) => index < start || index >= start + size);
        const env = { ...controlled, ...Object.fromEntries(remaining.map((key) => [key, process.env[key]])) };
        if (await probe(env) < 4_000) { suspects = remaining; partitions = Math.max(2, partitions - 1); reduced = true; break; }
      }
      if (!reduced) { if (partitions >= suspects.length) break; partitions = Math.min(suspects.length, partitions * 2); }
    }
    // Names only: never print CI credentials or any environment values.
    throw new Error(`Controlled module loading is slow; required inherited environment keys: ${suspects.join(", ")}`);
  }
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
  // Existing IPC tests use 5s initialization deadlines. Diagnose an unsuitable
  // runner here instead of cascading into dozens of long test/hook timeouts.
  if (elapsed.slice(1).some((milliseconds) => milliseconds >= 5_000)) {
    throw new Error(`Warm worker startup exceeds the existing 5s IPC deadline: ${elapsed.join(", ")}ms`);
  }
} finally {
  AgentCoreRuntimeClient.prototype.emit = originalEmit;
  if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
