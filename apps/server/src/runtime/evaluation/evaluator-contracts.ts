import { z } from "zod";

export const evaluatorId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const evaluateCandidateRequestSchema = z.object({ evaluator_revision_id: evaluatorId, artifact_id: evaluatorId, artifact_version: z.number().int().positive() }).strict();
export type EvaluateCandidateRequest = z.infer<typeof evaluateCandidateRequestSchema>;

const metricSchema = z.object({ minimum: z.number().finite(), maximum: z.number().finite(), unit: z.string().min(1).max(64), precision: z.number().int().min(0).max(10) }).strict()
  .refine((value) => value.minimum <= value.maximum, "Invalid metric range");
/** Small explicit data contract for the first registry version; executable submissions are never accepted. */
export const evaluatorRegistrationSchema = z.object({
  id: evaluatorId, researchId: evaluatorId, ownerSessionId: evaluatorId, workspace: z.string().min(1), protocolRevision: evaluatorId, environmentRevisionId: evaluatorId,
  submission: z.object({ format: z.literal("json"), minItems: z.number().int().min(1), maxItems: z.number().int().min(1).max(1_000_000), minimum: z.number().finite(), maximum: z.number().finite() }).strict()
    .refine((value) => value.minItems <= value.maxItems && value.minimum <= value.maximum, "Invalid submission bounds"),
  metrics: z.record(evaluatorId, metricSchema).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 32, "Require 1–32 aggregate metrics"),
  validityChecks: z.array(evaluatorId).min(1).max(32).refine((value) => new Set(value).size === value.length, "Duplicate check labels"),
  timeoutSeconds: z.number().int().min(1).max(600), maxSubmissionBytes: z.number().int().min(1).max(16 * 1024 * 1024), maxQueries: z.number().int().min(1).max(100),
  visibility: z.enum(["validation", "final_holdout"]),
  // Operator case descriptions; activation separately requires executable frozen acceptance.json cases.
  acceptance: z.object({ knownAnswer: z.string().min(1).max(2048), negativeCases: z.array(z.string().min(1).max(2048)).min(1).max(32), boundaryCases: z.array(z.string().min(1).max(2048)).min(1).max(32) }).strict(),
}).strict();
export type EvaluatorRegistration = z.infer<typeof evaluatorRegistrationSchema>;
export const evaluatorRevisionSchema = evaluatorRegistrationSchema.extend({ schemaVersion: z.literal(1), registeredAt: z.string().datetime(),
  evaluatorCodeDigest: digestSchema, protectedDataDigest: digestSchema, environmentDigest: digestSchema });
export type EvaluatorRevision = z.infer<typeof evaluatorRevisionSchema>;

export class EvaluatorError extends Error {
  constructor(readonly code: "invalid_request" | "unauthorized" | "revision_unavailable" | "invalid_submission" | "invalid_result" | "untrusted_provenance") { super(code); }
}

export function validateSubmission(bytes: Buffer, revision: EvaluatorRegistration): void {
  if (bytes.length > revision.maxSubmissionBytes) throw new EvaluatorError("invalid_submission");
  try {
    const limits = revision.submission;
    const schema = z.object({ predictions: z.array(z.number().finite().min(limits.minimum).max(limits.maximum)).min(limits.minItems).max(limits.maxItems) }).strict();
    schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { throw new EvaluatorError("invalid_submission"); }
}

/** Never publish evaluator logs or arbitrary JSON; only the approved bounded aggregate fields. */
export function validateEvaluatorResult(value: unknown, revision: EvaluatorRegistration) {
  try { return validatedResult(value, revision); } catch { throw new EvaluatorError("invalid_result"); }
}

function validatedResult(value: unknown, revision: EvaluatorRegistration) {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, metric] of Object.entries(revision.metrics)) shape[name] = z.number().finite().min(metric.minimum).max(metric.maximum);
  const result = z.object({ metrics: z.object(shape).strict(), validity: z.object({ passed: z.boolean(), checks: z.array(z.string()).max(revision.validityChecks.length) }).strict() }).strict().parse(value);
  const checks = result.validity.checks;
  if (new Set(checks).size !== checks.length || checks.some((check) => !revision.validityChecks.includes(check)) || result.validity.passed && revision.validityChecks.some((check) => !checks.includes(check))) throw new Error("Invalid evaluator checks");
  const metrics: Record<string, number> = {};
  for (const [name, metric] of Object.entries(revision.metrics)) {
    const score = result.metrics[name] as number;
    metrics[name] = Number(score.toFixed(metric.precision));
    if (metrics[name]! < metric.minimum || metrics[name]! > metric.maximum) throw new Error("Rounded metric outside approved range");
  }
  return { metrics: result.validity.passed ? metrics : {}, validity: result.validity };
}
