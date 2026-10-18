import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { withFileWriteLock, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";

export const MAX_SECONDS = 3600;
export const MAX_EXECUTIONS = 100;
export const executionKinds = ["bash", "notebook", "mcp", "subagent", "job"] as const;
export type ExecutionKind = typeof executionKinds[number];
const counts = z.object(Object.fromEntries(executionKinds.map((kind) => [kind, z.number().int().min(0).max(MAX_EXECUTIONS).optional()]))).strict() as z.ZodType<Partial<Record<ExecutionKind, number>>>;
export const budgetLimitsSchema = z.object({ max_seconds: z.number().int().min(1).max(MAX_SECONDS).optional(), max_executions: z.number().int().min(1).max(MAX_EXECUTIONS).optional(), by_kind: counts.optional() }).strict();
export type BudgetLimits = z.infer<typeof budgetLimitsSchema>;
const nodeSchema = z.object({ parent: z.string().optional(), cancelled: z.boolean().optional(), deadline: z.number().finite().positive(), maxExecutions: z.number().int().min(1).max(MAX_EXECUTIONS), used: z.number().int().min(0).max(MAX_EXECUTIONS), usage: counts.optional(), limits: counts.optional() }).strict();
const budgetSchema = nodeSchema.omit({ parent: true }).extend({
  nodes: z.record(z.string(), nodeSchema).optional(), reservations: z.record(z.string(), z.literal(true)).optional(), scopeLocked: z.boolean().optional(),
  maxEvaluations: z.unknown().optional(), evaluations: z.unknown().optional(),
}).strict().transform(({ maxEvaluations: _old, evaluations: _evaluations, ...budget }) => budget);
export type Budget = z.infer<typeof budgetSchema>;
export async function readBudget(path: string): Promise<Budget | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  let parsed; try { parsed = budgetSchema.safeParse(JSON.parse(text)); } catch { throw new Error("Invalid saved execution budget; refusing to reset its limits"); }
  if (!parsed.success) throw new Error("Invalid saved execution budget; refusing to reset its limits");
  return parsed.data;
}
const hash = (id: string) => createHash("sha256").update(id).digest("hex");
const fresh = (limits: BudgetLimits = {}) => ({ deadline: Date.now() + (limits.max_seconds ?? MAX_SECONDS) * 1000, maxExecutions: limits.max_executions ?? MAX_EXECUTIONS, used: 0 });
function narrow(node: z.infer<typeof nodeSchema>, limits: BudgetLimits) {
  if (limits.max_seconds !== undefined) node.deadline = Math.min(node.deadline, Date.now() + limits.max_seconds * 1000);
  if (limits.max_executions !== undefined) node.maxExecutions = Math.min(node.maxExecutions, limits.max_executions);
  for (const kind of executionKinds) if (limits.by_kind?.[kind] !== undefined) (node.limits ??= {})[kind] = Math.min(node.limits?.[kind] ?? MAX_EXECUTIONS, limits.by_kind[kind]!);
}
/** One locked ledger commits global and ancestor-local reservations atomically. */
export class ExecutionBudgetLedger {
  constructor(readonly cwd: string, readonly owner: string, readonly inherited = false, readonly nodeId?: string) {}
  async path(researchId?: string): Promise<string> { return this.withPath(researchId, async (path) => path); }
  private async withPath<T>(researchId: string | undefined, operation: (path: string) => Promise<T>): Promise<T> {
    const pathFor = (id: string) => workspaceFile(this.cwd, `execution-budgets/${hash(id)}.json`);
    const bindingPath = workspaceFile(this.cwd, `execution-budget-scopes/${hash(this.owner)}.json`);
    return withFileWriteLock(bindingPath, async () => {
      let binding: { researchId: string } | null = null;
      try { binding = z.object({ researchId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/) }).strict().parse(JSON.parse(await readFile(bindingPath, "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid execution budget scope; refusing to reset"); }
      if (researchId && this.inherited) throw new Error("Children cannot change the shared budget scope");
      if (researchId && binding && binding.researchId !== researchId) throw new Error("Cannot change an operation's budget scope");
      if (researchId && !binding) {
        const prior = await readBudget(pathFor(this.owner));
        if (prior && (prior.used || prior.scopeLocked !== false)) throw new Error("Bind research_id before the first execution or operation budget");
        const shared = pathFor(`research:${researchId}`);
        await withFileWriteLock(shared, async () => { if (!await readBudget(shared)) await writeJsonAtomic(shared, prior ?? fresh()); });
        binding = { researchId }; await writeJsonAtomic(bindingPath, binding);
      }
      const target = pathFor(binding ? `research:${binding.researchId}` : this.owner);
      await withFileWriteLock(target, async () => {
        if (!await readBudget(target)) {
          if (binding || this.inherited) throw new Error("Missing inherited shared execution budget; refusing to reset");
          await writeJsonAtomic(target, { ...fresh(), scopeLocked: false });
        }
      });
      return operation(target);
    });
  }
  private ancestors(budget: Budget) {
    const nodes: Array<z.infer<typeof nodeSchema>> = [budget];
    let id = this.nodeId; const seen = new Set<string>();
    while (id) {
      if (seen.has(id) || !budget.nodes?.[id]) throw new Error("Invalid or missing inherited budget node; refusing to reset");
      seen.add(id); const node = budget.nodes[id]!; nodes.push(node); id = node.parent;
    }
    return nodes;
  }
  async status() {
    // Atomic file replacement makes ordinary inspection lock-free. Only first
    // admission initializes state under the scope/ledger transaction.
    let binding: { researchId: string } | undefined;
    try { binding = z.object({ researchId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/) }).strict().parse(JSON.parse(await readFile(workspaceFile(this.cwd, `execution-budget-scopes/${hash(this.owner)}.json`), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid execution budget scope; refusing to reset"); }
    const path = workspaceFile(this.cwd, `execution-budgets/${hash(binding ? `research:${binding.researchId}` : this.owner)}.json`);
    const budget = await readBudget(path) ?? (await readBudget(await this.path()))!;
    const nodes = this.ancestors(budget);
    return { cancelled: nodes.some((node) => node.cancelled), node_id: this.nodeId, remaining_by_kind: Object.fromEntries(executionKinds.map((kind) => [kind, Math.max(0, Math.min(...nodes.map((node) => (node.limits?.[kind] ?? MAX_EXECUTIONS) - (node.usage?.[kind] ?? 0))))])), deadline: Math.min(...nodes.map((node) => node.deadline)), maxExecutions: nodes[this.nodeId ? 1 : 0]!.maxExecutions, used: nodes[this.nodeId ? 1 : 0]!.used,
      remaining_executions: Math.max(0, Math.min(...nodes.map((node) => node.maxExecutions - node.used))),
      usage: nodes[this.nodeId ? 1 : 0]!.usage ?? {}, global_used: budget.used, global_max_executions: budget.maxExecutions };
  }
  async configure(limits: BudgetLimits, researchId?: string) {
    budgetLimitsSchema.parse(limits);
    await this.withPath(researchId, (path) => withFileWriteLock(path, async () => { const budget = (await readBudget(path))!; const nodes = this.ancestors(budget); narrow(nodes[this.nodeId ? 1 : 0]!, limits); budget.scopeLocked = true; await writeJsonAtomic(path, budget); }));
    return this.status();
  }
  async createChild(id: string, limits: BudgetLimits = {}) {
    budgetLimitsSchema.parse(limits);
    await this.withPath(undefined, (path) => withFileWriteLock(path, async () => {
      const budget = (await readBudget(path))!; const ancestors = this.ancestors(budget);
      if (ancestors.some((node) => node.cancelled)) throw new Error("Execution task cancelled");
      if (Math.min(...ancestors.map((node) => node.deadline)) <= Date.now()) throw new Error("Execution time budget exhausted");
      const node = (budget.nodes ??= {})[id] ??= { ...fresh(), ...(this.nodeId ? { parent: this.nodeId } : {}) };
      if (node.parent !== this.nodeId) throw new Error("Budget node owner changed");
      // Reopening must reuse the original deadline, never a fresh window.
      narrow(node, limits); node.deadline = Math.min(node.deadline, ...ancestors.map((ancestor) => ancestor.deadline));
      await writeJsonAtomic(path, budget);
    }));
    return new ExecutionBudgetLedger(this.cwd, this.owner, true, id);
  }
  async cancel(childId?: string) {
    await this.withPath(undefined, (path) => withFileWriteLock(path, async () => {
      const budget = (await readBudget(path))!; const nodes = this.ancestors(budget);
      const target = childId ? budget.nodes?.[childId] : nodes[this.nodeId ? 1 : 0];
      if (childId && target && target.parent !== this.nodeId) throw new Error("Budget node owner changed");
      if (target) { target.cancelled = true; await writeJsonAtomic(path, budget); }
    }));
  }
  async reserve(kind: ExecutionKind, operationId: string, invocationId: string, units = 1) {
    if (!Number.isSafeInteger(units) || units < 1 || units > MAX_EXECUTIONS) throw new Error("Invalid execution reservation");
    await this.withPath(undefined, (path) => withFileWriteLock(path, async () => {
      const budget = (await readBudget(path))!; const nodes = this.ancestors(budget);
      if (nodes.some((node) => node.cancelled)) throw new Error("Execution task cancelled");
      if (nodes.some((node) => node.deadline <= Date.now())) throw new Error("Execution time budget exhausted");
      const key = hash(JSON.stringify([this.nodeId, kind, operationId, invocationId]));
      if (budget.reservations?.[key]) return;
      if (nodes.some((node) => node.used + units > node.maxExecutions)) throw new Error("Execution call budget exhausted");
      if (nodes.some((node) => (node.usage?.[kind] ?? 0) + units > (node.limits?.[kind] ?? MAX_EXECUTIONS))) throw new Error(`Execution ${kind} budget exhausted`);
      for (const node of nodes) { node.used += units; (node.usage ??= {})[kind] = (node.usage?.[kind] ?? 0) + units; }
      (budget.reservations ??= {})[key] = true; budget.scopeLocked = true; await writeJsonAtomic(path, budget);
    }));
    return this.status();
  }
}

/** A restored worker/job observes cancellations and deadline reductions from
 * the same durable tree. Callers own process termination and terminal records. */
export function watchExecutionDeadline(ledger: ExecutionBudgetLedger, expired: (error: Error) => void): () => Promise<void> {
  let stopped = false, pending: Promise<void> | undefined;
  const check = async () => {
    try {
      const status = await ledger.status();
      if (!stopped && (status.cancelled || status.deadline <= Date.now())) { stopped = true; expired(new Error(status.cancelled ? "Execution task cancelled" : "Execution time budget exhausted")); }
    } catch (error) { if (!stopped) { stopped = true; expired(error instanceof Error ? error : new Error(String(error))); } }
    finally { pending = undefined; if (stopped) clearInterval(timer); }
  };
  const tick = () => { if (!stopped && !pending) pending = check(); };
  const timer = setInterval(tick, 200); timer.unref?.(); tick();
  // Drain the in-flight read/lock operation before workspace teardown.
  return async () => { stopped = true; clearInterval(timer); await pending; };
}
