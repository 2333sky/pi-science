import { evaluateCandidateRequestSchema, EvaluatorError } from "./evaluator-contracts.js";
import { resolveEvaluatorArtifact, type VerifiedCandidateProvenance } from "./evaluator-artifact-input.js";
import type { EvaluatorRegistry } from "./evaluator-registry.js";

/** Authenticated server context, obtained independently of evaluation arguments. */
export interface EvaluatorCaller { sessionId: string; workspace: string; researchId: string; parentSessionId?: string; delegatedAgent?: string; operationId: string }

/** Input gate only: no execution, budget admission, score, or tool registration.
 * Resolver dependencies MUST be bound by the authenticated control plane, not a model. */
export class EvaluatorInputService {
  constructor(private readonly registry: EvaluatorRegistry,
    private readonly authenticate: () => Promise<EvaluatorCaller>,
    private readonly provenance: (artifactId: string, version: number) => Promise<VerifiedCandidateProvenance>) {}

  async prepare(input: unknown) {
    const parsed = evaluateCandidateRequestSchema.safeParse(input);
    if (!parsed.success) throw new EvaluatorError("invalid_request");
    const caller = await this.authenticate();
    if (!caller.sessionId || !caller.operationId || caller.parentSessionId !== undefined || caller.delegatedAgent !== undefined) throw new EvaluatorError("unauthorized");
    const revision = await this.registry.load(parsed.data.evaluator_revision_id);
    if (caller.sessionId !== revision.ownerSessionId || caller.workspace !== revision.workspace || caller.researchId !== revision.researchId) throw new EvaluatorError("unauthorized");
    const proof = await this.provenance(parsed.data.artifact_id, parsed.data.artifact_version);
    const candidate = await resolveEvaluatorArtifact(parsed.data, revision, proof);
    // The service must reauthorize immediately before atomic admission/launch;
    // this preparation result is neither a capability token nor a durable approval.
    await this.registry.load(parsed.data.evaluator_revision_id);
    return { revision, candidate };
  }
}
