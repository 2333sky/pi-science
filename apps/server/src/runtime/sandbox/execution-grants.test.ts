import { ExecutionBudgetLedger } from "../executions/execution-budget.js";
import { mkdtemp, realpath, mkdir, rm, writeFile, symlink, rename, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createExecutionGrant, executionGrantPolicy, revokeExecutionGrant, assertExecutionGrantTool } from "./execution-grants.js";
import { workspacePolicy } from "./policy.js";
import { sandboxBashTool } from "../agent/worker/sandbox-bash.js";
import { NodeExecutionEnv, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/node";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "generic-grant-"))); roots.push(cwd);
  const home = await mkdtemp(join(tmpdir(), "generic-grant-state-")); roots.push(home); vi.stubEnv("PI_SCIENCE_HOME", home); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host");
  await mkdir(join(cwd, "patches/first/input"), { recursive: true }); await mkdir(join(cwd, "patches/first/work"));
  await writeFile(join(cwd, "patches/first/input/approved.txt"), "approved");
  await mkdir(join(cwd, "evaluator")); await writeFile(join(cwd, "evaluator/private.txt"), "DO NOT READ");
  const ledger = new ExecutionBudgetLedger(cwd, "op"); await ledger.configure({ max_seconds: 30 });
  const child = await ledger.createChild("worker");
  const input = { workspace: cwd, workerKey: "worker", budgetOwner: "op", deadline: (await child.status()).deadline, tools: ["read", "bash", "notebook_read", "notebook_run"], selection: { cwd: "patches/first/work", read_paths: ["patches/first/input"], write_paths: ["patches/first/work"] }, parentPolicy: await workspacePolicy(cwd) };
  const id = await createExecutionGrant(input);
  return { cwd, input, id, identity: { cwd, sessionId: "worker", budgetOperationId: "op", executionGrantId: id } };
}
it("binds arbitrary Draft/Patch roots without any research ID or Candidate authority", async () => {
  const { cwd, identity, input, id } = await fixture();
  const policy = await executionGrantPolicy(identity, undefined, "bash");
  expect(policy).toMatchObject({ mode: "required", scope: "confined", network: { mode: "none" }, cwd: join(cwd, "patches/first/work") });
  expect(policy.writePaths).toEqual([join(cwd, "patches/first/work")]);
  expect(await createExecutionGrant(input)).toBe(id);
  await expect(executionGrantPolicy({ ...identity, sessionId: "other" })).rejects.toThrow("binding mismatch");
  await expect(executionGrantPolicy({ ...identity, budgetOperationId: "other" })).rejects.toThrow("binding mismatch");
  await expect(assertExecutionGrantTool(identity, "write")).rejects.toThrow("ceiling");
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(join(cwd, ".pi-science/execution-budget-scopes"))).toEqual([]);
});
it("rejects changed authority on recovery, escapes and raw policy-shaped selections", async () => {
  const { cwd, input } = await fixture();
  await expect(createExecutionGrant({ ...input, selection: { ...input.selection, cwd: "evaluator", write_paths: ["evaluator"] } })).rejects.toThrow("cannot change");
  await expect(createExecutionGrant({ ...input, workerKey: "escape", selection: { cwd: "..", write_paths: [".."], read_paths: [] } })).rejects.toThrow("exceeds parent");
  await expect(createExecutionGrant({ ...input, workerKey: "forged", selection: { ...input.selection, network: { mode: "allowlist" } } as never })).rejects.toThrow();
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  await expect(createExecutionGrant({ ...input, workerKey: "private", selection: { cwd: ".pi-science", write_paths: [".pi-science"], read_paths: [] } })).rejects.toThrow("protected");
});
it("cannot widen inherited directories, tools or deadlines", async () => {
  const { cwd, input, identity, id } = await fixture();
  const parentPolicy = await executionGrantPolicy(identity);
  const child = { ...input, workerKey: "child", parentPolicy, parentId: id };
  await expect(createExecutionGrant({ ...child, selection: { cwd: "evaluator", read_paths: [], write_paths: ["evaluator"] } })).rejects.toThrow("exceeds parent");
  await expect(createExecutionGrant({ ...child, tools: ["write"] })).rejects.toThrow("tool/deadline");
  await expect(createExecutionGrant({ ...child, deadline: input.deadline + 1 })).rejects.toThrow("tool/deadline");
  await new ExecutionBudgetLedger(cwd, "op", true, "worker").createChild("child");
  const childId = await createExecutionGrant(child);
  await revokeExecutionGrant(id);
  await expect(executionGrantPolicy({ cwd, sessionId: "child", budgetOperationId: "op", executionGrantId: childId })).rejects.toThrow("revoked");
});
it("refuses linked trees, changed root identities and expired grants", async () => {
  const { cwd, input, identity } = await fixture();
  await symlink(join(cwd, "evaluator/private.txt"), join(cwd, "patches/first/work/link"));
  await expect(executionGrantPolicy(identity)).rejects.toThrow("links");
  await rm(join(cwd, "patches/first/work/link"));
  await rename(join(cwd, "patches/first/work"), join(cwd, "patches/first/old")); await mkdir(join(cwd, "patches/first/work"));
  await expect(executionGrantPolicy(identity)).rejects.toThrow("identity changed");
  await new ExecutionBudgetLedger(cwd, "op", true).createChild("expired");
  await expect(createExecutionGrant({ ...input, workerKey: "expired", deadline: Date.now() - 1 })).rejects.toThrow("expired");
});
it.skipIf(process.env.PI_SCIENCE_SANDBOX_TEST !== "1" || !["linux", "darwin"].includes(process.platform)).each(["grant", "budget"])("revokes a real running Bash process through the independent watchdog: %s", async (kind) => {
  const { cwd, identity, id } = await fixture();
  const env = new NodeExecutionEnv({ cwd });
  const run = sandboxBashTool(identity).execute("running", { command: "printf ready > ready.txt; sleep 20; printf leaked > leaked.txt", timeout: 25 }, () => {}, { env }, { operationId: "op", invocationId: "running" } as never, BACKGROUND_CONTEXT);
  const settled = run.then(() => "succeeded", () => "revoked");
  try {
    await vi.waitFor(async () => expect(await readFile(join(cwd, "patches/first/work/ready.txt"), "utf8")).toBe("ready"), { timeout: 10_000 });
    if (kind === "grant") await revokeExecutionGrant(id); else await new ExecutionBudgetLedger(cwd, "op", true, "worker").cancel();
    expect(await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve("watchdog-timeout"), 3000))])).toBe("revoked");
    await expect(readFile(join(cwd, "patches/first/work/leaked.txt"))).rejects.toThrow();
  } finally { await env.cleanup(BACKGROUND_CONTEXT); }
}, 15_000);

it("pins operator authority and protects the private ledger from file tools", async () => {
  const { cwd, input, identity, id } = await fixture();
  const { executionGrantsDirectory } = await import("./execution-grants.js");
  const { workspaceFileTool } = await import("../agent/worker/workspace-file-tool.js");
  const path = join(await executionGrantsDirectory(), `${id}.json`);
  const execute = vi.fn(); const fileTool = workspaceFileTool({ name: "read", execute } as never, cwd, []);
  await expect(fileTool.execute("read", { path }, () => {}, {} as never, {} as never, BACKGROUND_CONTEXT)).rejects.toThrow("service-owned");
  expect(execute).not.toHaveBeenCalled();
  const config = join(await realpath(tmpdir()), `grant-profiles-${Date.now()}-${Math.random()}.json`); roots.push(config);
  await writeFile(config, JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", config);
  const ledger = new ExecutionBudgetLedger(cwd, "op", true); await ledger.createChild("configured");
  const configured = await createExecutionGrant({ ...input, workerKey: "configured" });
  const bound = { ...identity, sessionId: "configured", executionGrantId: configured };
  expect((await executionGrantPolicy(bound)).scope).toBe("confined");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, profiles: { analysis: { allowedDomains: ["example.org"] } } }), { mode: 0o600 });
  await expect(executionGrantPolicy(bound)).rejects.toThrow("operator authority changed");
});
