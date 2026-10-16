import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonLineUnlocked, readJsonLines, withFileWriteLock, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import { persistArtifactBytes } from "../artifacts/artifact-content-store.js";
import { executionIdFor, executionRepository } from "../executions/execution-repository.js";
import { reserveEvaluation } from "../executions/execution-budget.js";
import { EvaluatorInputService, type EvaluatorCaller } from "./evaluator-authorization.js";
import { EvaluatorError, evaluateCandidateRequestSchema } from "./evaluator-contracts.js";
import { resolveCandidateProvenance } from "./evaluator-identity.js";
import { EvaluatorRegistry } from "./evaluator-registry.js";
import { readEvaluatorFile, sha256 } from "./evaluator-files.js";
import { runEvaluator } from "./evaluator-runner.js";

export interface EvaluationResponse {
  evaluation_id: string; execution_id: string; status: "admitted" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost";
  evaluator_revision_id: string; candidate_artifact: { artifact_id: string; version: number; sha256: string };
  metrics?: Record<string, number>; validity?: { passed: boolean; checks: string[] }; reason_code?: string;
  artifact_refs: Array<{ artifact_id: string; version: number }>;
  provenance: { protocol_revision: string; evaluator_digest: string; data_digest: string; environment_digest: string; environment_revision: string; revision_manifest_digest: string; submission_schema_digest: string; policy_id?: string };
}
interface EvaluationRecord { fingerprint: string; ownerSessionId: string; researchId: string; createdAt: string; exitCode: number | null; response: EvaluationResponse }

/** The authenticated server IPC adapter owns caller identity and invocation keys. */
export class EvaluatorService {
  constructor(private readonly registry: EvaluatorRegistry) {}

  async evaluate(authenticate: () => Promise<EvaluatorCaller>, invocationId: string, input: unknown, signal?: AbortSignal): Promise<EvaluationResponse> {
    const request = evaluateCandidateRequestSchema.parse(input);
    const caller = await authenticate(); signal?.throwIfAborted();
    const executionId = executionIdFor("trusted-evaluator", caller.sessionId, caller.operationId, invocationId);
    const evaluationId = executionId.replace(/^exec_/, "evaluation_");
    const records = join(this.registry.root, ".evaluations"); await mkdir(records, { recursive: true, mode: 0o700 });
    const path = join(records, `${evaluationId}.json`);
    return withFileWriteLock(path, async () => {
      const currentCaller = await authenticate();
      if (JSON.stringify(currentCaller) !== JSON.stringify(caller)) throw new EvaluatorError("unauthorized");
      const fingerprint = sha256(JSON.stringify(request));
      let saved: EvaluationRecord | undefined;
      try { saved = JSON.parse((await readEvaluatorFile(path, 256 * 1024)).toString("utf8")) as EvaluationRecord; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (saved) {
        if (saved.fingerprint !== fingerprint || saved.ownerSessionId !== caller.sessionId || saved.researchId !== caller.researchId) throw new EvaluatorError("invalid_request");
        if (["admitted", "running"].includes(saved.response.status)) {
          saved.response = { ...saved.response, status: "lost", reason_code: "owner_completion_unknown", metrics: undefined, artifact_refs: [] };
          await writeJsonAtomic(path, saved, { mode: 0o600 });
        }
        return this.finalize(caller, saved);
      }
      const prepared = await new EvaluatorInputService(this.registry, authenticate, (id, version) => resolveCandidateProvenance(caller, id, version)).prepare(request);
      const stage = await this.registry.stage(prepared.revision.id);
      try {
        if (sha256(JSON.stringify(stage.revision)) !== sha256(JSON.stringify(prepared.revision))) throw new EvaluatorError("revision_unavailable");
        const response: EvaluationResponse = { evaluation_id: evaluationId, execution_id: executionId, status: "admitted", evaluator_revision_id: prepared.revision.id,
          candidate_artifact: { artifact_id: request.artifact_id, version: request.artifact_version, sha256: prepared.candidate.sha256 }, artifact_refs: [],
          provenance: { protocol_revision: prepared.revision.protocolRevision, evaluator_digest: prepared.revision.evaluatorCodeDigest, data_digest: prepared.revision.protectedDataDigest, environment_digest: prepared.revision.environmentDigest, environment_revision: prepared.revision.environmentRevisionId, revision_manifest_digest: sha256(JSON.stringify(prepared.revision)), submission_schema_digest: sha256(JSON.stringify(prepared.revision.submission)) } };
        const record: EvaluationRecord = { fingerprint, ownerSessionId: caller.sessionId, researchId: caller.researchId, createdAt: new Date().toISOString(), exitCode: null, response };
        const budget = await this.registry.withActive(prepared.revision, async () => {
          if (JSON.stringify(await authenticate()) !== JSON.stringify(caller)) throw new EvaluatorError("unauthorized"); signal?.throwIfAborted();
          const reserved = await reserveEvaluation(caller.workspace, caller.operationId, caller.researchId, evaluationId, prepared.revision.id, fingerprint, prepared.revision.visibility === "final_holdout" ? 1 : prepared.revision.maxQueries);
          await writeJsonAtomic(path, record, { mode: 0o600 });
          await executionRepository.start(caller.workspace, { execution_id: executionId, kind: "tool", surface: "research", producer: "evaluate_candidate", correlation: { session_id: caller.sessionId, operation_id: caller.operationId, tool_call_id: invocationId }, request: { ...request, input_sha256: prepared.candidate.sha256, research_id: caller.researchId }, runtime: { ...response.provenance, execution_mode: "required" }, artifacts: [{ artifact_id: request.artifact_id, version: request.artifact_version, relation: "input" }] });
          return reserved;
        });
        record.response.status = "running"; await writeJsonAtomic(path, record, { mode: 0o600 });
        try {
          const result = await runEvaluator(stage.directory, prepared.revision, prepared.candidate.bytes, Math.max(0.001, Math.min(prepared.revision.timeoutSeconds, (budget.deadline - Date.now()) / 1000)), signal);
          record.exitCode = result.exit_code;
          record.response = { ...response, status: result.status, reason_code: result.reason_code, ...(result.validity ? { validity: result.validity } : {}), ...(result.status === "succeeded" ? { metrics: result.metrics } : {}), provenance: { ...response.provenance, policy_id: result.policy_id } };
        } catch { record.response = { ...response, status: signal?.aborted ? "cancelled" : "failed", reason_code: signal?.aborted ? "cancelled" : "evaluation_unavailable" }; }
        if (signal?.aborted) record.response = { ...record.response, status: "cancelled", metrics: undefined, validity: undefined, artifact_refs: [], reason_code: "cancelled" };
        // Completion is durable before publication. Replays only finish this commit,
        // never rerun the OS process; uncertain admitted/running records become lost.
        await writeJsonAtomic(path, record, { mode: 0o600 });
        return this.finalize(caller, record);
      } finally { await stage.cleanup(); }
    });
  }

  private async finalize(caller: EvaluatorCaller, record: EvaluationRecord): Promise<EvaluationResponse> {
    const response = { ...record.response };
    if (response.status === "succeeded") {
      const artifactId = sha256(response.evaluation_id).slice(0, 24);
      const bytes = Buffer.from(JSON.stringify(response)); const digest = sha256(bytes);
      await persistArtifactBytes(caller.workspace, digest, bytes);
      const path = workspaceFile(caller.workspace, "artifacts.jsonl"); const resultPath = `results/metrics-${response.evaluation_id}.json`;
      await withFileWriteLock(path, async () => {
        const previous = (await readJsonLines<{ artifact_id: string; sha256: string }>(path)).filter((item) => item.artifact_id === artifactId);
        if (previous.some((item) => item.sha256 !== digest)) throw new Error("Conflicting evaluation artifact");
        if (!previous.length) await appendJsonLineUnlocked(path, { artifact_id: artifactId, version: 1, path: resultPath, kind: "text", mime: "application/json", size: bytes.length, sha256: digest, published_at: record.createdAt, producer: { tool: "evaluate_candidate", session_id: caller.sessionId, execution_id: response.execution_id }, inputs: [response.candidate_artifact], environment: response.provenance, verification: { status: "passed", checks: { sha256: digest, size: bytes.length }, checked_at: record.createdAt } });
      });
      const provenancePath = workspaceFile(caller.workspace, "provenance.jsonl");
      await withFileWriteLock(provenancePath, async () => {
        const rows = await readJsonLines<{ executionId?: string; tool?: string }>(provenancePath);
        if (!rows.some((row) => row.executionId === response.execution_id && row.tool === "evaluate_candidate")) {
          const content = `artifact:${artifactId}:1:${digest}`;
          await appendJsonLineUnlocked(provenancePath, { path: resultPath, version: 1, ts: Date.parse(record.createdAt) / 1000, tool: "evaluate_candidate", sessionId: caller.sessionId, executionId: response.execution_id, content, contentHash: sha256(content).slice(0, 16) });
        }
      });
      response.artifact_refs = [{ artifact_id: artifactId, version: 1 }];
    }
    if (!await executionRepository.get(caller.workspace, response.execution_id)) await executionRepository.start(caller.workspace, { execution_id: response.execution_id, kind: "tool", surface: "research", producer: "evaluate_candidate", correlation: { session_id: caller.sessionId, operation_id: caller.operationId }, runtime: { ...response.provenance, execution_mode: "required" } });
    await executionRepository.finish(caller.workspace, response.execution_id, { status: response.status as "succeeded" | "failed" | "timed_out" | "cancelled" | "lost", producer: "evaluate_candidate", result: { ...response, exit_code: record.exitCode }, artifacts: response.artifact_refs.map((ref) => ({ ...ref, relation: "output" })) });
    return response;
  }
}
