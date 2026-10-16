import { z } from "zod";
import { join } from "node:path";
import { EvaluatorRegistry } from "./evaluator-registry.js";
import { readEvaluatorFile, sha256 } from "./evaluator-files.js";
import { runEvaluator } from "./evaluator-runner.js";
import { validateEvaluatorResult } from "./evaluator-contracts.js";

const casesSchema = z.array(z.object({ kind: z.enum(["baseline", "negative", "boundary"]), submission: z.unknown(), expected: z.unknown().optional() }).strict()).min(3).max(16);
/** Offline operator approval only. No Agent-facing route invokes this function. */
export async function approveEvaluator(registry: EvaluatorRegistry, id: string, allowFinal = false): Promise<void> {
  const revision = await registry.load(id);
  if (revision.visibility === "final_holdout" && !allowFinal) throw new Error("Final holdout requires explicit approve-final authorization");
  const raw = await readEvaluatorFile(join(registry.root, id, "evaluator/acceptance.json"), 64 * 1024);
  const cases = casesSchema.parse(JSON.parse(raw.toString("utf8")));
  for (const kind of ["baseline", "negative", "boundary"]) if (!cases.some((item) => item.kind === kind)) throw new Error("Acceptance requires baseline, negative and boundary cases");
  for (const item of cases) {
    const stage = await registry.stage(id);
    try {
      if (sha256(JSON.stringify(stage.revision)) !== sha256(JSON.stringify(revision))) throw new Error("Approval revision changed");
      let passed = false;
      try {
        const result = await runEvaluator(stage.directory, revision, Buffer.from(JSON.stringify(item.submission)));
        if (item.kind !== "negative") {
          const expected = validateEvaluatorResult(item.expected, revision);
          passed = result.status === "succeeded" && expected.validity.passed && JSON.stringify({ metrics: result.metrics, validity: result.validity }) === JSON.stringify(expected);
        } else passed = result.status === "failed";
      } catch { passed = item.kind === "negative"; }
      if (!passed) throw new Error("Evaluator acceptance case failed");
    } finally { await stage.cleanup(); }
  }
  await registry.activate(id, sha256(JSON.stringify(revision)), sha256(raw), allowFinal);
}
