import { join } from "node:path";
import { z } from "zod";
import { metadataRoot } from "../../storage/persistence.js";
import { canonicalDirectory, isWithin } from "../sandbox/policy.js";
import { digestSchema, EvaluatorError, type EvaluateCandidateRequest, type EvaluatorRevision, validateSubmission } from "./evaluator-contracts.js";
import { readEvaluatorFile, sha256 } from "./evaluator-files.js";

/** Must come from control-plane provenance, never manifest.producer or request data.
 * The server Worker adapter resolves authenticated session ancestry/research and
 * immutable execution evidence before supplying this binding. No default resolver exists. */
export interface VerifiedCandidateProvenance {
  artifactId: string; version: number; sha256: string; size: number;
  workspace: string; ownerSessionId: string; researchId: string;
}

const manifestSchema = z.object({ artifact_id: z.string(), version: z.number().int().positive(), sha256: digestSchema, size: z.number().int().nonnegative(), path: z.string().min(1) }).passthrough();

/** Evaluator-only resolver. Unlike preview, it never falls back to live workspace bytes. */
export async function resolveEvaluatorArtifact(request: EvaluateCandidateRequest, revision: EvaluatorRevision, provenance: VerifiedCandidateProvenance): Promise<{ bytes: Buffer; sha256: string }> {
  if (provenance.artifactId !== request.artifact_id || provenance.version !== request.artifact_version || provenance.workspace !== revision.workspace || provenance.ownerSessionId !== revision.ownerSessionId || provenance.researchId !== revision.researchId || !digestSchema.safeParse(provenance.sha256).success) throw new EvaluatorError("untrusted_provenance");
  try {
    const state = await canonicalDirectory(metadataRoot(revision.workspace));
    // Legacy Agent-writable state is not an authoritative publication/provenance source.
    if (isWithin(revision.workspace, state)) throw new Error("Artifact state is not private");
    const manifests = await readEvaluatorFile(join(state, "artifacts.jsonl"), 16 * 1024 * 1024);
    const matches = manifests.toString("utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown)
      .filter((value) => value && typeof value === "object" && (value as Record<string, unknown>).artifact_id === request.artifact_id && (value as Record<string, unknown>).version === request.artifact_version)
      .map((value) => manifestSchema.parse(value));
    if (!matches.length) throw new Error("Missing historical manifest");
    // Reverification appends a second manifest in the existing store. Accept duplicates
    // only if their immutable fields agree; conflicting versions are never resolved by order.
    const first = matches[0]!;
    if (matches.some((item) => item.sha256 !== first.sha256 || item.size !== first.size || item.path !== first.path)) throw new Error("Ambiguous artifact version");
    if (first.sha256 !== provenance.sha256 || first.size !== provenance.size || first.size > revision.maxSubmissionBytes || !first.path.endsWith(".json")) throw new Error("Invalid candidate manifest");
    const bytes = await readEvaluatorFile(join(state, "artifact-content", first.sha256), revision.maxSubmissionBytes);
    if (bytes.length !== first.size || sha256(bytes) !== first.sha256) throw new Error("Candidate snapshot digest mismatch");
    validateSubmission(bytes, revision);
    return { bytes, sha256: first.sha256 };
  } catch { throw new EvaluatorError("invalid_submission"); }
}
