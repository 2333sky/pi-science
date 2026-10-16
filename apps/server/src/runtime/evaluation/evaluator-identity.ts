import { AgentSessionRegistry } from "../agent/agent-session-registry.js";
import { candidatePublications } from "../artifacts/candidate-publication.js";
import { executionRepository } from "../executions/execution-repository.js";
import { boundResearchId } from "../executions/execution-budget.js";
import { metadataRoot } from "../../storage/persistence.js";
import { runtimeReadPolicy } from "../sandbox/read-grants.js";
import { requirePrivateDirectory } from "./evaluator-files.js";
import { isWithin } from "../sandbox/policy.js";
import { EvaluatorError } from "./evaluator-contracts.js";
import type { EvaluatorCaller } from "./evaluator-authorization.js";
import type { VerifiedCandidateProvenance } from "./evaluator-artifact-input.js";

export async function authenticateEvaluatorParent(cwd: string, sessionId: string, operationId: string): Promise<EvaluatorCaller> {
  const state = metadataRoot(cwd);
  if (isWithin(cwd, state)) throw new EvaluatorError("unauthorized");
  const policy = await runtimeReadPolicy(true);
  if (!policy.protectedRoots.some((root) => isWithin(root, state))) throw new EvaluatorError("unauthorized");
  await requirePrivateDirectory(state);
  const registration = await new AgentSessionRegistry().get(cwd, sessionId);
  if (registration?.state !== "active" || registration.purpose !== "conversation" || registration.parentSessionId !== undefined) throw new EvaluatorError("unauthorized");
  return { sessionId, workspace: cwd, researchId: await boundResearchId(cwd, operationId), operationId };
}

/** A manifest producer string is never authority. Check the trusted publication ledger,
 * actual successful isolated execution and private server-owned session ancestry. */
export async function resolveCandidateProvenance(caller: EvaluatorCaller, artifactId: string, version: number): Promise<VerifiedCandidateProvenance> {
  const registry = new AgentSessionRegistry();
  for (const proof of await candidatePublications(caller.workspace, artifactId, version)) {
    if (proof.artifact_id !== artifactId || proof.version !== version) continue;
    const execution = await executionRepository.get(caller.workspace, proof.executionId);
    if (execution?.status !== "succeeded" || execution.runtime.execution_mode !== "required" || execution.correlation.session_id !== proof.sessionId || (execution.request.research_id ?? execution.runtime.research_id) !== caller.researchId || !execution.artifacts.some((ref) => ref.relation === "output" && ref.artifact_id === artifactId && ref.version === version)) continue;
    const candidateId = execution.correlation.candidate_id;
    // Kernel candidate IDs may be derived from the immutable server-captured path.
    const match = /^research\/([^/]+)\/candidates\/([A-Za-z0-9_-]+)\/work\/.+\.json$/.exec(proof.path);
    if (!match || match[1] !== caller.researchId || candidateId && match[2] !== candidateId) continue;
    let sessionId: string | undefined = proof.sessionId;
    let owned = false;
    for (let depth = 0; sessionId && depth < 4; depth++) {
      const session = await registry.get(caller.workspace, sessionId);
      if (session?.state !== "active") break;
      if (sessionId === caller.sessionId) { owned = true; break; }
      sessionId = session.parentSessionId;
    }
    if (owned) return { artifactId, version, sha256: proof.sha256, size: proof.size, workspace: caller.workspace, ownerSessionId: caller.sessionId, researchId: caller.researchId };
  }
  throw new EvaluatorError("untrusted_provenance");
}
