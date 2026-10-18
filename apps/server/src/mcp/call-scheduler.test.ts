import { createHash, randomUUID } from "node:crypto";
import { workspaceFile, writeJsonAtomic, readJson } from "../storage/persistence.js";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ownerProcessIdentity } from "../runtime/jobs/job-lease-manager.js";
import { acquireMcpCall } from "./call-scheduler.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function workspace() { const root = await mkdtemp(join(tmpdir(), "mcp-scheduler-")); roots.push(root); return root; }
it("shares connector slots with another worker process and reclaims a killed owner", async () => {
  const cwd = await workspace();
  const slots = await Promise.all(Array.from({ length: 4 }, () => acquireMcpCall(cwd, "connector")));
  const module = new URL("./call-scheduler.ts", import.meta.url).href;
  const script = `import {acquireMcpCall} from ${JSON.stringify(module)};console.log('requesting');await acquireMcpCall(${JSON.stringify(cwd)},'connector');console.log('acquired');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = ""; child.stdout!.on("data", (chunk) => output += chunk); child.stderr!.on("data", (chunk) => error += chunk);
  const milestone = (text: string) => new Promise<void>((resolve, reject) => {
    const check = () => { if (output.includes(text)) { child.stdout!.off("data", check); resolve(); } };
    child.stdout!.on("data", check); child.once("error", reject); child.once("exit", (code) => { if (!output.includes(text)) reject(new Error(`child exited ${code}: ${error}`)); }); check();
  });
  const requesting = milestone("requesting"), ready = milestone("acquired");
  try {
    await requesting; await new Promise((resolve) => setTimeout(resolve, 100)); expect(output).not.toContain("acquired");
    await slots.shift()!.release(); await ready;
    const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
    const recovered = await acquireMcpCall(cwd, "connector", undefined, 2000); await recovered.release();
  } finally { child.kill("SIGKILL"); await Promise.all(slots.map((slot) => slot.release())); }
}, 10_000);
it("bounds queued work, supports cancellation and keeps connector capacities independent", async () => {
  const cwd = await workspace();
  const slots = await Promise.all(Array.from({ length: 4 }, () => acquireMcpCall(cwd, "one")));
  const controllers = Array.from({ length: 17 }, () => new AbortController());
  const waiting = controllers.map((controller) => acquireMcpCall(cwd, "one", controller.signal).catch((error) => error));
  try {
    const overflow = await Promise.race(waiting);
    expect(overflow).toBeInstanceOf(Error); expect(overflow.message).toContain("queue is full");
    const separate = await acquireMcpCall(cwd, "two"); await separate.release();
    controllers.forEach((controller) => controller.abort(new Error("cancelled")));
    const results = await Promise.all(waiting);
    expect(results.filter((error) => error instanceof Error && error.message === "cancelled")).toHaveLength(16);
    await expect(acquireMcpCall(cwd, "one", undefined, 100)).rejects.toThrow("queue wait timed out");
  } finally { controllers.forEach((controller) => controller.abort()); await Promise.all(waiting); await Promise.all(slots.map((slot) => slot.release())); }
});


it("reclaims reused live PIDs from active slots and the FIFO head, including legacy tickets", async () => {
  const cwd = await workspace(); const connector = "reused-owner";
  const path = workspaceFile(cwd, `mcp-call-queues/${createHash("sha256").update(connector).digest("hex")}.json`);
  // The PID is alive, but these tickets belong to an earlier process incarnation.
  const identity = ownerProcessIdentity(process.pid, process.platform)!;
  expect(identity).toBeTruthy();
  const stale = () => ({ id: randomUUID(), pid: process.pid, process_identity: { ...identity, value: `${identity.value}-previous-incarnation` } });
  await writeJsonAtomic(path, { active: Array.from({ length: 4 }, stale), waiting: [stale(), { id: randomUUID(), pid: process.pid }] });
  const slot = await acquireMcpCall(cwd, connector, undefined, 2000);
  try {
    const state = await readJson<{ active: unknown[]; waiting: unknown[] }>(path, { active: [], waiting: [] });
    expect(state.active).toHaveLength(1); expect(state.waiting).toHaveLength(0);
    expect(state.active[0]).toMatchObject({ pid: process.pid, process_identity: { value: expect.any(String) } });
  } finally { await slot.release(); }
});
