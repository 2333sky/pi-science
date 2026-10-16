import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createHash } from "node:crypto";
import { withFileWriteLock, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
export interface Budget { deadline: number; maxExecutions: number; used: number; maxEvaluations?: number; evaluations?: Record<string, { revisionId: string; fingerprint: string }> }
export class EvaluationBudgetError extends Error { readonly code = "budget_exhausted"; constructor() { super("Evaluation budget exhausted"); } }
export const MAX_SECONDS = 3600;
export const MAX_EXECUTIONS = 100;
const budgetSchema = z.object({ deadline: z.number().finite().positive(), maxExecutions: z.number().int().min(1).max(MAX_EXECUTIONS), used: z.number().int().min(0).max(MAX_EXECUTIONS), maxEvaluations: z.number().int().min(1).max(MAX_EXECUTIONS).optional(), evaluations: z.record(z.string(), z.object({ revisionId: z.string(), fingerprint: z.string() }).strict()).optional() }).strict();
export async function readBudget(path: string): Promise<Budget | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const parsed = budgetSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error("Invalid saved execution budget; refusing to reset its limits");
  return parsed.data;
}


export const budgetHash = (id: string) => createHash("sha256").update(id).digest("hex");
export async function boundResearchId(cwd: string, operationId: string): Promise<string> {
  return z.object({ researchId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/) }).strict().parse(JSON.parse(await readFile(workspaceFile(cwd, `execution-budget-scopes/${budgetHash(operationId)}.json`), "utf8"))).researchId;
}
/** Generic call charge, per-revision queries and stable invocation ownership commit in one atomic budget write. */
export async function reserveEvaluation(cwd: string, operationId: string, researchId: string, key: string, revisionId: string, fingerprint: string, maxQueries: number): Promise<Budget> {
  if (await boundResearchId(cwd, operationId) !== researchId) throw new Error("Research budget binding mismatch");
  const path = workspaceFile(cwd, `execution-budgets/${budgetHash(`research:${researchId}`)}.json`);
  return withFileWriteLock(path, async () => {
    const budget = await readBudget(path);
    if (!budget) throw new Error("Missing research budget");
    const previous = budget.evaluations?.[key];
    if (previous) { if (previous.revisionId !== revisionId || previous.fingerprint !== fingerprint) throw new Error("Evaluation invocation input changed"); return budget; }
    if (budget.deadline <= Date.now() || budget.used >= budget.maxExecutions || Object.keys(budget.evaluations ?? {}).length >= (budget.maxEvaluations ?? MAX_EXECUTIONS) || Object.values(budget.evaluations ?? {}).filter((entry) => entry.revisionId === revisionId).length >= maxQueries) throw new EvaluationBudgetError();
    budget.used++; budget.evaluations = { ...budget.evaluations, [key]: { revisionId, fingerprint } };
    await writeJsonAtomic(path, budget);
    return budget;
  });
}
