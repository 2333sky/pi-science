/** Bounded local benchmark; creates and removes its own workspace and private state. */
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT, NodeExecutionEnv, createReadTool, type AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core/node";
import { ExecutionBudgetLedger } from "../src/runtime/executions/execution-budget.js";
import { assertExecutionGrantTool, createExecutionGrant, executionGrantPolicy } from "../src/runtime/sandbox/execution-grants.js";
import { workspacePolicy } from "../src/runtime/sandbox/policy.js";
import { confinedReadTool } from "../src/runtime/agent/worker/confined-read-tool.js";

const samples = Number(process.env.GRANT_BENCH_SAMPLES ?? 5);
const sizes = (process.env.GRANT_BENCH_FILES ?? "0,5000,20000").split(",").map(Number);
if (!Number.isInteger(samples) || samples < 3 || samples > 10 || sizes.length > 4 || sizes.some((size) => !Number.isInteger(size) || size < 0 || size > 30000)) throw new Error("Benchmark bounds: 3–10 samples, up to four sizes of 0–30000 unrelated files");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "grant-benchmark-")));
const previous = { home: process.env.PI_SCIENCE_HOME, mode: process.env.PI_SCIENCE_EXECUTION_MODE };
const rows = [];
try {
  process.env.PI_SCIENCE_EXECUTION_MODE = "trusted-host"; // Setup only; grants still force required/offline.
  for (const unrelatedFiles of sizes) {
    const cwd = join(scratch, `workspace-${unrelatedFiles}`), home = join(scratch, `state-${unrelatedFiles}`);
    await mkdir(home); process.env.PI_SCIENCE_HOME = home;
    await mkdir(join(cwd, "task/input"), { recursive: true }); await mkdir(join(cwd, "task/work"));
    await writeFile(join(cwd, "task/input/read.txt"), "approved small scientific input\n");
    // Spread ordinary scientific files over many directories outside the assigned roots.
    for (let offset = 0; offset < unrelatedFiles; offset += 100) {
      const directory = join(cwd, "datasets", `part-${offset / 100}`); await mkdir(directory, { recursive: true });
      await Promise.all(Array.from({ length: Math.min(100, unrelatedFiles - offset) }, (_, index) => writeFile(join(directory, `${index}.csv`), "1,2,3\n")));
    }
    const ledger = new ExecutionBudgetLedger(cwd, "benchmark"); await ledger.configure({ max_seconds: 600 });
    const child = await ledger.createChild("worker");
    const id = await createExecutionGrant({ workspace: cwd, workerKey: "worker", budgetOwner: "benchmark", deadline: (await child.status()).deadline, tools: ["read"], selection: { cwd: "task/work", read_paths: ["task/input"], write_paths: ["task/work"] }, parentPolicy: await workspacePolicy(cwd) });
    const identity = { cwd, sessionId: "worker", budgetOperationId: "benchmark", executionGrantId: id };
    const env = new NodeExecutionEnv({ cwd });
    try {
      const tool = confinedReadTool(createReadTool(), identity);
      const measures = {
        authorization: async () => { await executionGrantPolicy(identity, undefined, "read"); },
        delegated_read: async () => {
          // Match the delegated Worker wrapper plus the real confined read path.
          await assertExecutionGrantTool(identity, "read");
          await tool.execute("benchmark", { path: "task/input/read.txt" }, () => {}, { env }, { operationId: "benchmark", invocationId: "benchmark", turnId: "benchmark", getMemo: async () => undefined, setMemo: async () => {} } as AgentHarnessToolInvocation, BACKGROUND_CONTEXT);
        },
      };
      for (const [operation, run] of Object.entries(measures)) {
        await run(); // One warmup, excluded from recorded samples.
        const times = [];
        for (let index = 0; index < samples; index++) { const start = performance.now(); await run(); times.push(performance.now() - start); }
        times.sort((a, b) => a - b);
        rows.push({ unrelatedFiles, grantFiles: 1, operation, samples, p50_ms: Number(times[Math.ceil(samples * .5) - 1]!.toFixed(2)), p95_ms: Number(times[Math.ceil(samples * .95) - 1]!.toFixed(2)) });
      }
    } finally { await env.cleanup(BACKGROUND_CONTEXT); }
  }
  process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, warmup: 1, rows }, null, 2) + "\n");
} finally {
  for (const [key, value] of [["PI_SCIENCE_HOME", previous.home], ["PI_SCIENCE_EXECUTION_MODE", previous.mode]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(scratch, { recursive: true, force: true });
}
