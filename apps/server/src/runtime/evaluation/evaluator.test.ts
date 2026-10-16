import { chmod, link, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metadataRoot, workspaceStateRoot } from "../../storage/persistence.js";
import { persistArtifactBytes } from "../artifacts/artifact-content-store.js";
import { EvaluatorInputService, type EvaluatorCaller } from "./evaluator-authorization.js";
import { resolveEvaluatorArtifact, type VerifiedCandidateProvenance } from "./evaluator-artifact-input.js";
import { evaluateCandidateRequestSchema, evaluatorRegistrationSchema, validateEvaluatorResult, validateSubmission, type EvaluatorRegistration, type EvaluatorRevision } from "./evaluator-contracts.js";
import { captureEvaluatorTree, EvaluatorReadBudget, readEvaluatorFile, sha256 } from "./evaluator-files.js";
import { EvaluatorRegistry, type EvaluatorSources } from "./evaluator-registry.js";

describe.skipIf(process.platform !== "linux")("trusted evaluator Phase A", () => {
  let directory: string; let workspace: string; let registry: EvaluatorRegistry; let sources: EvaluatorSources; let registration: EvaluatorRegistration;
  let revision: EvaluatorRevision; let proof: VerifiedCandidateProvenance; let caller: EvaluatorCaller;
  const bytes = Buffer.from('{"predictions":[0,1,0.5]}');
  const request = { evaluator_revision_id: "revision-1", artifact_id: "artifact-1", artifact_version: 1 };

  beforeEach(async () => {
    // Keep generated fixtures inside the checkout; no global app state is touched.
    directory = await mkdtemp(join(resolve("."), ".evaluator-test-"));
    workspace = join(directory, "workspace"); await mkdir(workspace);
    const root = join(directory, "private-registry"); await mkdir(root, { mode: 0o700 });
    vi.stubEnv("PI_SCIENCE_HOME", join(directory, "private-state"));
    sources = { evaluator: join(directory, "code"), dataset: join(directory, "data"), environment: join(directory, "env") };
    for (const source of Object.values(sources)) { await mkdir(source); await writeFile(join(source, "asset"), "immutable asset"); }
    vi.stubEnv("PI_SCIENCE_SANDBOX_READ_POLICY", join(directory, "operator-read-policy.json"));
    await writeFile(process.env.PI_SCIENCE_SANDBOX_READ_POLICY!, JSON.stringify({ schemaVersion: 1, dependencyRoots: [], protectedRoots: [root, ...Object.values(sources)] }), { mode: 0o600 });
    registration = { id: "revision-1", ownerSessionId: "parent-1", researchId: "research-1", workspace, protocolRevision: "protocol-1", environmentRevisionId: "env-1",
      submission: { format: "json", minItems: 1, maxItems: 4, minimum: 0, maximum: 1 }, metrics: { accuracy: { minimum: 0, maximum: 1, unit: "ratio", precision: 3 } }, validityChecks: ["schema_valid", "dataset_match"],
      timeoutSeconds: 30, maxSubmissionBytes: 1024, maxQueries: 3, visibility: "validation", acceptance: { knownAnswer: "operator baseline fixture", negativeCases: ["mismatched dataset"], boundaryCases: ["zero and one"] } };
    registry = new EvaluatorRegistry(root, [workspace]);
    revision = await registry.register(registration, sources);
    proof = { artifactId: "artifact-1", version: 1, sha256: sha256(bytes), size: bytes.length, workspace, ownerSessionId: "parent-1", researchId: "research-1" };
    caller = { sessionId: "parent-1", workspace, researchId: "research-1", operationId: "operation-1" };
    await mkdir(workspaceStateRoot(workspace), { recursive: true, mode: 0o700 });
    await persistArtifactBytes(workspace, proof.sha256, bytes);
    await writeFile(join(metadataRoot(workspace), "artifacts.jsonl"), JSON.stringify({ artifact_id: proof.artifactId, version: proof.version, path: "predictions.json", sha256: proof.sha256, size: proof.size, producer: { session_id: "forged-ignored" } }) + "\n");
  });
  afterEach(async () => { vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it("freezes source bytes and keeps the registered digests after source edits", async () => {
    await writeFile(join(sources.evaluator, "asset"), "changed original");
    expect(await registry.load(revision.id)).toEqual(revision);
    expect(await readFile(join(registry.root, revision.id, "evaluator", "asset"), "utf8")).toBe("immutable asset");
    expect(registration).not.toHaveProperty("evaluatorCodeDigest");
  });
  it("never replaces an existing revision, including concurrent registrations", async () => {
    const outcomes = await Promise.allSettled([registry.register({ ...registration, id: "new-id" }, sources), registry.register({ ...registration, id: "new-id" }, sources)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(registry.register(registration, sources)).rejects.toThrow();
    expect(await registry.load(revision.id)).toEqual(revision);
  });
  it("revokes durably and cannot reuse an ID", async () => {
    await registry.revoke(revision.id); await registry.revoke(revision.id);
    await expect(new EvaluatorRegistry(registry.root, [workspace]).load(revision.id)).rejects.toThrow("revision_unavailable");
    await expect(registry.register(registration, sources)).rejects.toThrow();
  });
  it("supports offline CLI registration/verification/revocation without enabling scoring", async () => {
    const manifest = join(directory, "registration.json"); await writeFile(manifest, JSON.stringify({ ...registration, id: "cli-revision" }));
    const cli = fileURLToPath(new URL("../../cli/evaluator-registry.ts", import.meta.url));
    const run = async (command: string, args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ["--import", "tsx", cli, command, registry.root, workspace, ...args])).stdout);
    expect(await run("register", [manifest, sources.evaluator, sources.dataset, sources.environment])).toMatchObject({ status: "registered", scoring_available: false });
    expect(await run("verify", ["cli-revision"])).toMatchObject({ status: "verified", scoring_available: false });
    expect(await run("revoke", ["cli-revision"])).toMatchObject({ status: "revoked", scoring_available: false });
    await expect(run("verify", ["cli-revision"])).rejects.toThrow();
  }, 15_000);
  it.each(["evaluator", "dataset", "environment"])("rejects frozen %s drift", async (asset) => {
    const path = join(registry.root, revision.id, asset, "asset"); await chmod(path, 0o600); await writeFile(path, "drifted");
    await expect(registry.load(revision.id)).rejects.toThrow("revision_unavailable");
    await registry.revoke(revision.id); // Broken registrations remain revocable.
  });
  it("includes executable mode and file paths in bundle identity", async () => {
    await chmod(join(registry.root, revision.id, "environment", "asset"), 0o500);
    await expect(registry.load(revision.id)).rejects.toThrow("revision_unavailable");
  });
  it("rejects public state permissions and registry/workspace overlap", async () => {
    await chmod(registry.root, 0o755);
    await expect(registry.load(revision.id)).rejects.toThrow("revision_unavailable");
    await chmod(registry.root, 0o700);
    await expect(new EvaluatorRegistry(directory, [workspace]).register({ ...registration, id: "other" }, sources)).rejects.toThrow();
  });
  it.each(["evaluator", "dataset", "environment"] as const)("rejects Agent-writable %s sources", async (kind) => {
    await expect(registry.register({ ...registration, id: "other" }, { ...sources, [kind]: workspace })).rejects.toThrow("overlap");
  });
  it("requires the shared operator policy even when no custom dependencies are configured", async () => {
    delete process.env.PI_SCIENCE_SANDBOX_READ_POLICY;
    await expect(registry.register({ ...registration, id: "other" }, sources)).rejects.toThrow("shared operator read policy");
    await expect(registry.load(revision.id)).rejects.toThrow("revision_unavailable");
  });
  it("rejects later policy changes exposing frozen assets", async () => {
    const file = process.env.PI_SCIENCE_SANDBOX_READ_POLICY!;
    const policy = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...policy, dependencyRoots: [sources.dataset] }));
    await expect(registry.register({ ...registration, id: "other" }, sources)).rejects.toThrow("runtime read grants");
    await expect(registry.load(revision.id)).rejects.toThrow("revision_unavailable");
  });
  it("rejects unprotected sources and system runtime read grants", async () => {
    await expect(registry.register({ ...registration, id: "other" }, { ...sources, evaluator: "/usr/bin" })).rejects.toThrow("runtime read grants");
    const source = join(directory, "unprotected"); await mkdir(source);
    await expect(registry.register({ ...registration, id: "other" }, { ...sources, evaluator: source })).rejects.toThrow("shared protected root");
  });
  it("streams a 96 MiB revision and repeated verification without retaining bundle bytes", async () => {
    for (const source of Object.values(sources)) { const handle = await open(join(source, "asset"), "w"); try { await handle.truncate(32 * 1024 * 1024); } finally { await handle.close(); } }
    const baseline = process.memoryUsage().arrayBuffers; let peak = baseline;
    const sample = () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }; const timer = setInterval(sample, 1);
    try {
      const large = await registry.register({ ...registration, id: "large" }, sources);
      for (let index = 0; index < 2; index++) expect(await registry.load(large.id)).toEqual(large);
      sample();
      expect(peak - baseline).toBeLessThan(16 * 1024 * 1024);
      const path = join(registry.root, large.id, "dataset", "asset"); await chmod(path, 0o600);
      const changed = await open(path, "r+"); try { await changed.write(Buffer.from("drift"), 0, 5, 32 * 1024 * 1024 - 5); } finally { await changed.close(); }
      await expect(registry.load(large.id)).rejects.toThrow("revision_unavailable");
    } finally { clearInterval(timer); }
  }, 30_000);
  it("rejects three individually valid bundles exceeding the shared 256 MiB limit", async () => {
    for (const source of Object.values(sources)) { const handle = await open(join(source, "asset"), "w"); try { await handle.truncate(96 * 1024 * 1024); } finally { await handle.close(); } }
    await expect(registry.register({ ...registration, id: "too-large" }, sources)).rejects.toThrow("aggregate byte budget");
  }, 30_000);
  it("shares entry and byte accounting across separate tree captures and preserves v1 digests", async () => {
    const budget = new EvaluatorReadBudget(20);
    const first = await captureEvaluatorTree(sources.evaluator, budget);
    expect(first.digest).toBe(sha256(JSON.stringify([["asset", false, sha256("immutable asset")]])));
    await expect(captureEvaluatorTree(sources.dataset, budget)).rejects.toThrow("aggregate byte budget");
    const entries = new EvaluatorReadBudget(); for (let index = 0; index < 10_000; index++) entries.enter();
    expect(() => entries.enter()).toThrow("aggregate entry budget");
  });
  it.each(["symlink", "hardlink"])("rejects %s assets", async (kind) => {
    const path = join(sources.dataset, "linked");
    if (kind === "symlink") await symlink(join(sources.evaluator, "asset"), path); else await link(join(sources.evaluator, "asset"), path);
    await expect(registry.register({ ...registration, id: "other" }, sources)).rejects.toThrow();
  });
  it("rejects aliased parent directories and bounded file overflow", async () => {
    const alias = join(directory, "alias"); await symlink(sources.dataset, alias);
    await expect(readEvaluatorFile(join(alias, "asset"), 100)).rejects.toThrow();
    await expect(readEvaluatorFile(join(sources.dataset, "asset"), 2)).rejects.toThrow();
  });
  it.each(["../revision", "/tmp/revision", ".", ".."])("rejects revision path %s", async (id) => {
    await expect(registry.load(id)).rejects.toThrow("revision_unavailable");
    expect(evaluateCandidateRequestSchema.safeParse({ ...request, evaluator_revision_id: id }).success).toBe(false);
  });
  it.each(["code", "command", "path", "session_id", "candidate_id", "policy", "environment", "dataset_id"])("rejects model-selected %s", (field) => {
    expect(evaluateCandidateRequestSchema.safeParse({ ...request, [field]: "forged" }).success).toBe(false);
  });
  it("requires operator acceptance metadata and valid limits", () => {
    expect(evaluatorRegistrationSchema.safeParse({ ...registration, acceptance: undefined }).success).toBe(false);
    expect(evaluatorRegistrationSchema.safeParse({ ...registration, maxQueries: 0 }).success).toBe(false);
    expect(evaluatorRegistrationSchema.safeParse({ ...registration, metrics: { accuracy: { minimum: 1, maximum: 0, unit: "ratio", precision: 3 } } }).success).toBe(false);
  });
  it("prepares an owned immutable snapshot independently of the current work file", async () => {
    await writeFile(join(workspace, "predictions.json"), "changed live bytes");
    const service = new EvaluatorInputService(registry, async () => caller, async () => proof);
    const result = await service.prepare(request);
    expect(result.candidate.bytes).toEqual(bytes); expect(result.candidate.sha256).toBe(proof.sha256);
  });
  it.each([{ parentSessionId: "parent-1" }, { parentSessionId: "" }, { delegatedAgent: "auto-research/reviewer" }, { delegatedAgent: "auto-research/experimenter" }, { sessionId: "other" }, { researchId: "other" }, { workspace: "/other" }, { operationId: "" }])("rejects unauthorized server context %j", async (override) => {
    const provenance = vi.fn(async () => proof);
    const service = new EvaluatorInputService(registry, async () => ({ ...caller, ...override }), provenance);
    await expect(service.prepare(request)).rejects.toThrow("unauthorized"); expect(provenance).not.toHaveBeenCalled();
  });
  it("rechecks revocation after resolving input", async () => {
    const service = new EvaluatorInputService(registry, async () => caller, async () => { await registry.revoke(revision.id); return proof; });
    await expect(service.prepare(request)).rejects.toThrow("revision_unavailable");
  });
  it.each([{ sha256: "0".repeat(64) }, { version: 2 }, { artifactId: "other" }, { researchId: "other" }, { ownerSessionId: "other" }, { workspace: "/other" }])("rejects forged provenance %j", async (override) => {
    await expect(resolveEvaluatorArtifact(request, revision, { ...proof, ...override })).rejects.toThrow();
  });
  it("rejects stale bytes, even if a matching live file exists", async () => {
    const snapshot = join(metadataRoot(workspace), "artifact-content", proof.sha256);
    await writeFile(snapshot, "changed bytes"); await writeFile(join(workspace, "predictions.json"), bytes);
    await expect(resolveEvaluatorArtifact(request, revision, proof)).rejects.toThrow("invalid_submission");
    await rm(snapshot);
    await expect(resolveEvaluatorArtifact(request, revision, proof)).rejects.toThrow("invalid_submission");
  });
  it.each(["symlink", "hardlink"])("rejects %s snapshot substitution", async (kind) => {
    const snapshot = join(metadataRoot(workspace), "artifact-content", proof.sha256); const other = join(directory, "other.json");
    await writeFile(other, bytes); await rm(snapshot);
    if (kind === "symlink") await symlink(other, snapshot); else await link(other, snapshot);
    await expect(resolveEvaluatorArtifact(request, revision, proof)).rejects.toThrow("invalid_submission");
  });
  it("rejects conflicting historical manifests", async () => {
    const path = join(metadataRoot(workspace), "artifacts.jsonl"); const text = await readFile(path, "utf8");
    const duplicate = { ...JSON.parse(text), sha256: "0".repeat(64) };
    await writeFile(path, text + JSON.stringify(duplicate) + "\n");
    await expect(resolveEvaluatorArtifact(request, revision, proof)).rejects.toThrow("invalid_submission");
  });
  it("allows identical immutable manifests after verification appends metadata", async () => {
    const path = join(metadataRoot(workspace), "artifacts.jsonl"); const text = await readFile(path, "utf8");
    await writeFile(path, text + JSON.stringify({ ...JSON.parse(text), verification: { status: "passed" } }) + "\n");
    expect((await resolveEvaluatorArtifact(request, revision, proof)).bytes).toEqual(bytes);
  });
  it("rejects a torn manifest log rather than dropping unknown publication evidence", async () => {
    const path = join(metadataRoot(workspace), "artifacts.jsonl"); const text = await readFile(path, "utf8");
    await writeFile(path, text + '{"artifact_id":');
    await expect(resolveEvaluatorArtifact(request, revision, proof)).rejects.toThrow("invalid_submission");
  });
  it("refuses legacy Agent-writable metadata as an authority", async () => {
    await rm(workspaceStateRoot(workspace), { recursive: true });
    await persistArtifactBytes(workspace, proof.sha256, bytes);
    await expect(resolveEvaluatorArtifact(request, revision, proof)).rejects.toThrow("invalid_submission");
  });
  it.each(['{"predictions":[]}', '{"predictions":[2]}', '{"predictions":[1e400]}', '{"predictions":["1"]}', '{"predictions":[0],"code":"evil"}', 'null', '{broken']) ("rejects invalid submission %s", (value) => {
    expect(() => validateSubmission(Buffer.from(value), registration)).toThrow("invalid_submission");
  });
  it("accepts declared submission boundaries and refuses malformed UTF-8", () => {
    expect(() => validateSubmission(bytes, registration)).not.toThrow();
    expect(() => validateSubmission(Buffer.from([0xff]), registration)).toThrow("invalid_submission");
    expect(() => validateSubmission(bytes, { ...registration, maxSubmissionBytes: 1 })).toThrow("invalid_submission");
  });
  const validResult = { metrics: { accuracy: 0.912345 }, validity: { passed: true, checks: ["schema_valid", "dataset_match"] } };
  it("returns only rounded approved aggregates and suppresses invalid scores", () => {
    expect(validateEvaluatorResult(validResult, registration)).toEqual({ metrics: { accuracy: 0.912 }, validity: validResult.validity });
    expect(validateEvaluatorResult({ ...validResult, validity: { passed: false, checks: ["schema_valid"] } }, registration).metrics).toEqual({});
  });
  it.each([{ ...validResult, stdout: "hidden labels" }, { ...validResult, metrics: { accuracy: NaN } }, { ...validResult, metrics: { accuracy: Infinity } }, { ...validResult, metrics: { accuracy: 2 } }, { ...validResult, metrics: { accuracy: 0.9, row: 1 } }, { ...validResult, validity: { passed: true, checks: ["schema_valid"] } }, { ...validResult, validity: { passed: true, checks: ["schema_valid", "schema_valid"] } }, { ...validResult, validity: { passed: false, checks: ["hidden row"] } }])("rejects unsafe or invalid result %j", (value) => {
    expect(() => validateEvaluatorResult(value, registration)).toThrow(/^invalid_result$/);
  });
});
