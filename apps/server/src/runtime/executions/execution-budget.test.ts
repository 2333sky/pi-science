import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBudget } from "./execution-budget.js";
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it("retains historical consumed calls and deadlines without reviving retired scoring quotas", async () => {
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "budget-compat-"));
  const path = join(root, "budget.json"); const budget = { deadline: 1000, maxExecutions: 8, used: 5 };
  await writeFile(path, JSON.stringify({ ...budget, maxEvaluations: 2, evaluations: { old: { revisionId: "historical", fingerprint: "recorded" } } }));
  expect(await readBudget(path)).toEqual(budget);
  await writeFile(path, JSON.stringify({ ...budget, unexpected: true })); await expect(readBudget(path)).rejects.toThrow("Invalid saved execution budget");
});

it("atomically enforces global, ancestor-local and per-kind caps across siblings and recovery", async () => {
  const { ExecutionBudgetLedger } = await import("./execution-budget.js");
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "budget-tree-"));
  const parent = new ExecutionBudgetLedger(root, "owner");
  await parent.configure({ max_executions: 8, by_kind: { bash: 2, mcp: 1 } });
  const one = await parent.createChild("one", { max_executions: 2, by_kind: { bash: 1 } });
  const grandchild = await one.createChild("grandchild", { max_executions: 8 });
  const two = await parent.createChild("two");
  await grandchild.reserve("bash", "grandchild-operation", "first");
  await expect(one.reserve("bash", "one-operation", "second")).rejects.toThrow("bash budget exhausted");
  await two.reserve("bash", "two-operation", "second");
  await expect(two.reserve("bash", "two-operation", "third")).rejects.toThrow("bash budget exhausted");
  await grandchild.reserve("mcp", "grandchild-operation", "mcp");
  await expect(grandchild.reserve("notebook", "grandchild-operation", "over-local")).rejects.toThrow("call budget exhausted");
  await expect(two.reserve("mcp", "two-operation", "over-global-kind")).rejects.toThrow("mcp budget exhausted");
  // The ledger, rather than a worker-local memo, owns replay idempotency.
  await new ExecutionBudgetLedger(root, "owner", true, "grandchild").reserve("bash", "grandchild-operation", "first");
  expect(await parent.status()).toMatchObject({ used: 3, usage: { bash: 2, mcp: 1 } });
  expect(await grandchild.status()).toMatchObject({ used: 2, remaining_executions: 0 });
  await grandchild.configure({ max_executions: 100, max_seconds: 3600 });
  await expect(grandchild.reserve("notebook", "grandchild-operation", "over-local")).rejects.toThrow("call budget exhausted");
  await one.cancel();
  expect((await grandchild.status()).cancelled).toBe(true);
  expect((await two.status()).cancelled).toBe(false);
  await expect(grandchild.reserve("notebook", "grandchild-operation", "after-stop")).rejects.toThrow("task cancelled");
});

it("propagates narrower deadlines and rejects missing nodes instead of granting a fresh quota", async () => {
  const { ExecutionBudgetLedger } = await import("./execution-budget.js");
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "budget-deadline-"));
  const parent = new ExecutionBudgetLedger(root, "owner"); await parent.configure({ max_seconds: 30 });
  const child = await parent.createChild("one", { max_seconds: 20 });
  const original = (await child.status()).deadline;
  await parent.configure({ max_seconds: 1 });
  expect((await child.status()).deadline).toBeLessThan(original);
  expect((await child.status()).deadline).toBe((await parent.status()).deadline);
  await expect(new ExecutionBudgetLedger(root, "owner", true, "missing").status()).rejects.toThrow("missing inherited budget node");
});
