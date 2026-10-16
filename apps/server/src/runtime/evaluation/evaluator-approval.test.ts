import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveEvaluator } from "./evaluator-approval.js";
import { EvaluatorError, type EvaluatorRevision } from "./evaluator-contracts.js";
import { runEvaluator, type EvaluatorOutcome } from "./evaluator-runner.js";
import type { EvaluatorRegistry } from "./evaluator-registry.js";

vi.mock("./evaluator-runner.js", () => ({ runEvaluator: vi.fn() }));
describe.skipIf(process.platform !== "linux")("operator evaluator acceptance", () => {
  let root: string; let registry: EvaluatorRegistry; let revision: EvaluatorRevision; let cases: Array<Record<string, unknown>>;
  const cleanup = vi.fn(); const activate = vi.fn();
  const good = (score: number): EvaluatorOutcome => ({ status: "succeeded", exit_code: 0, policy_id: "policy", metrics: { accuracy: score }, validity: { passed: true, checks: ["schema_valid", "dataset_match"] } });
  const rejection: EvaluatorOutcome = { status: "failed", exit_code: 0, policy_id: "policy", reason_code: "invalid_result", validity: { passed: false, checks: ["schema_valid"] } };
  const saveCases = () => writeFile(join(root, "revision/evaluator/acceptance.json"), JSON.stringify(cases));
  beforeEach(async () => {
    vi.clearAllMocks();
    await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "approval-regression-"));
    await mkdir(join(root, "revision/evaluator"), { recursive: true });
    revision = { id: "revision", workspace: join(root, "workspace"), researchId: "study", ownerSessionId: "parent", protocolRevision: "protocol", environmentRevisionId: "env", schemaVersion: 1, registeredAt: "2026-10-16T00:00:00.000Z", evaluatorCodeDigest: "a".repeat(64), protectedDataDigest: "b".repeat(64), environmentDigest: "c".repeat(64), submission: { format: "json", minItems: 1, maxItems: 2, minimum: 0, maximum: 1 }, metrics: { accuracy: { minimum: 0, maximum: 1, precision: 3, unit: "ratio" } }, validityChecks: ["schema_valid", "dataset_match"], timeoutSeconds: 1, maxSubmissionBytes: 1024, maxQueries: 2, visibility: "validation", acceptance: { knownAnswer: "baseline", negativeCases: ["dataset mismatch"], boundaryCases: ["opposite predictions"] } };
    cases = [{ kind: "baseline", submission: { predictions: [0, 1] }, expected: { metrics: { accuracy: 1 }, validity: good(1).validity } }, { kind: "negative", submission: { predictions: [0] }, expected_rejection: { reason_code: "invalid_result", failed_checks: ["dataset_match"] } }, { kind: "boundary", submission: { predictions: [1, 0] }, expected: { metrics: { accuracy: 0 }, validity: good(0).validity } }];
    await saveCases();
    registry = { root, load: vi.fn().mockResolvedValue(revision), stage: vi.fn().mockResolvedValue({ directory: root, revision, cleanup }), activate } as unknown as EvaluatorRegistry;
    vi.mocked(runEvaluator).mockReset().mockResolvedValueOnce(good(1)).mockResolvedValueOnce(rejection).mockResolvedValueOnce(good(0));
  });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("activates only after the declared structured rejection and positive cases match", async () => {
    await approveEvaluator(registry, "revision");
    expect(runEvaluator).toHaveBeenCalledTimes(3); expect(cleanup).toHaveBeenCalledTimes(3);
    expect(activate).toHaveBeenCalledWith("revision", expect.stringMatching(/^[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{64}$/), false);
  });
  it.each([
    ["sandbox startup", new Error("sandbox startup failed")],
    ["configuration", new Error("operator policy changed")],
    ["missing dependency", Object.assign(new Error("missing interpreter"), { code: "ENOENT" })],
    ["input validation before launch", new EvaluatorError("invalid_submission")],
    ["runner timeout exception", new Error("runner deadline")],
  ])("does not approve a negative case on %s exceptions", async (_name, error) => {
    vi.mocked(runEvaluator).mockReset().mockResolvedValueOnce(good(1)).mockRejectedValueOnce(error);
    await expect(approveEvaluator(registry, "revision")).rejects.toThrow();
    expect(activate).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["timeout", { ...rejection, status: "timed_out", exit_code: null }],
    ["cancellation", { ...rejection, status: "cancelled", exit_code: null }],
    ["unrelated nonzero exit", { ...rejection, exit_code: 7 }],
    ["interpreter crash", { ...rejection, exit_code: 139 }],
    ["signal termination", { ...rejection, exit_code: null }],
    ["malformed output", { ...rejection, validity: undefined }],
    ["wrong reason code", { ...rejection, reason_code: "output_limit" }],
    ["wrong failed check", { ...rejection, validity: { passed: false, checks: ["dataset_match"] } }],
    ["unexpected additional failed check", { ...rejection, validity: { passed: false, checks: [] } }],
    ["all checks passed", { ...rejection, validity: { passed: false, checks: ["schema_valid", "dataset_match"] } }],
    ["unexpected success", good(1)],
  ] as Array<[string, EvaluatorOutcome]>)("does not approve a negative case on %s", async (_name, outcome) => {
    vi.mocked(runEvaluator).mockReset().mockResolvedValueOnce(good(1)).mockResolvedValueOnce(outcome);
    await expect(approveEvaluator(registry, "revision")).rejects.toThrow("acceptance case failed");
    expect(activate).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, { reason_code: "failed", failed_checks: ["dataset_match"] }, { reason_code: "invalid_result", failed_checks: [] }, { reason_code: "invalid_result", failed_checks: ["unknown"] }, { reason_code: "invalid_result", failed_checks: ["dataset_match", "dataset_match"] }])("rejects missing or invalid expected rejection metadata %j", async (expected) => {
    cases[1]!.expected_rejection = expected; await saveCases();
    await expect(approveEvaluator(registry, "revision")).rejects.toThrow();
    expect(runEvaluator).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled();
  });
});
