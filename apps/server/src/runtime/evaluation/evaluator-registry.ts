import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileWriteLock } from "../../storage/persistence.js";
import { canonicalDirectory, isWithin } from "../sandbox/policy.js";
import { evaluatorId, evaluatorRegistrationSchema, evaluatorRevisionSchema, EvaluatorError, type EvaluatorRevision } from "./evaluator-contracts.js";
import { captureEvaluatorTree, EvaluatorReadBudget, readEvaluatorFile, requirePrivateDirectory } from "./evaluator-files.js";
import { pathsOverlap, runtimeReadPolicy, type RuntimeReadPolicy } from "../sandbox/read-grants.js";

export interface EvaluatorSources { evaluator: string; dataset: string; environment: string }
/** Offline operator API only. Do not instantiate in an Agent Worker or expose through HTTP/tools.
 * Registration freezes assets; it does not certify a runner or enable official scoring. */
export class EvaluatorRegistry {
  constructor(readonly root: string, private readonly untrustedRoots: readonly string[]) {}

  private rejectRuntimeOverlap(path: string, readPolicy: RuntimeReadPolicy): void {
    if ([...readPolicy.systemReads, ...readPolicy.dependencyRoots!].some((read) => pathsOverlap(read, path))) throw new Error("Evaluator assets overlap sandbox runtime read grants");
    if (!readPolicy.protectedRoots.some((root) => isWithin(root, path))) throw new Error("Evaluator assets require a shared protected root");
  }

  private async checkRoots(workspace: string, readPolicy: RuntimeReadPolicy): Promise<void> {
    if (process.platform !== "linux") throw new Error("Evaluator registry requires Linux");
    await requirePrivateDirectory(this.root);
    this.rejectRuntimeOverlap(this.root, readPolicy);
    for (const path of [workspace, ...this.untrustedRoots]) {
      await canonicalDirectory(path);
      if (isWithin(path, this.root) || isWithin(this.root, path)) throw new Error("Evaluator state must be outside Agent workspaces");
      if (isWithin(path, readPolicy.file!)) throw new Error("Operator read policy must be outside Agent workspaces");
    }
  }

  async register(input: unknown, sources: EvaluatorSources): Promise<EvaluatorRevision> {
    const registration = evaluatorRegistrationSchema.parse(input);
    await requirePrivateDirectory(this.root);
    return withFileWriteLock(join(this.root, "registry"), async () => {
      const readPolicy = await runtimeReadPolicy(true);
      await this.checkRoots(registration.workspace, readPolicy);
      for (const source of Object.values(sources)) {
        await canonicalDirectory(source);
        for (const untrusted of [registration.workspace, ...this.untrustedRoots, this.root]) {
          if (pathsOverlap(untrusted, source)) throw new Error("Evaluator sources overlap untrusted workspace or registry");
        }
        this.rejectRuntimeOverlap(source, readPolicy);
      }
      const staging = join(this.root, `.staging-${randomUUID()}`); await mkdir(staging, { mode: 0o700 });
      try {
        const budget = new EvaluatorReadBudget();
        const trees = {
          evaluator: await captureEvaluatorTree(sources.evaluator, budget, join(staging, "evaluator")),
          dataset: await captureEvaluatorTree(sources.dataset, budget, join(staging, "dataset")),
          environment: await captureEvaluatorTree(sources.environment, budget, join(staging, "environment")),
        };
        const revision = evaluatorRevisionSchema.parse({ ...registration, schemaVersion: 1, registeredAt: new Date().toISOString(), evaluatorCodeDigest: trees.evaluator.digest, protectedDataDigest: trees.dataset.digest, environmentDigest: trees.environment.digest });
        if (Buffer.byteLength(JSON.stringify(revision)) > 256 * 1024) throw new Error("Evaluator manifest exceeds byte limit");
        await writeFile(join(staging, "manifest.json"), JSON.stringify(revision), { flag: "wx", mode: 0o400 });
        // A changing operator configuration invalidates preparation; never publish
        // assets validated under a different set of effective read grants.
        const current = await runtimeReadPolicy(true);
        if (JSON.stringify(current) !== JSON.stringify(readPolicy)) throw new Error("Operator read policy changed during registration");
        const destination = join(this.root, registration.id);
        await mkdir(destination, { mode: 0o700 });
        await rename(staging, destination);
        return revision;
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }

  async load(id: string): Promise<EvaluatorRevision> {
    try {
      evaluatorId.parse(id); await requirePrivateDirectory(this.root);
      return await withFileWriteLock(join(this.root, "registry"), async () => {
        const readPolicy = await runtimeReadPolicy(true);
        const directory = join(this.root, id); await canonicalDirectory(directory);
        // No approval cache: revocation is checked on every load, including after hashing.
        const revoked = async () => {
          try { await readEvaluatorFile(join(directory, "revoked.json"), 4096); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
        };
        if (await revoked()) throw new Error("Revoked");
        const revision = evaluatorRevisionSchema.parse(JSON.parse((await readEvaluatorFile(join(directory, "manifest.json"), 256 * 1024)).toString("utf8")));
        if (revision.id !== id) throw new Error("Revision identity mismatch");
        await this.checkRoots(revision.workspace, readPolicy);
        const budget = new EvaluatorReadBudget();
        for (const [name, expected] of [["evaluator", revision.evaluatorCodeDigest], ["dataset", revision.protectedDataDigest], ["environment", revision.environmentDigest]] as const) {
          if ((await captureEvaluatorTree(join(directory, name), budget)).digest !== expected) throw new Error("Frozen evaluator assets changed");
        }
        if (await revoked()) throw new Error("Revoked");
        if (JSON.stringify(await runtimeReadPolicy(true)) !== JSON.stringify(readPolicy)) throw new Error("Operator read policy changed during verification");
        return revision;
      });
    } catch { throw new EvaluatorError("revision_unavailable"); }
  }

  async revoke(id: string): Promise<void> {
    evaluatorId.parse(id); await requirePrivateDirectory(this.root);
    await withFileWriteLock(join(this.root, "registry"), async () => {
      const directory = await canonicalDirectory(join(this.root, id));
      // Revocation also works for drifted/partial registrations. Never reactivate an ID.
      try { await writeFile(join(directory, "revoked.json"), JSON.stringify({ revokedAt: new Date().toISOString() }), { flag: "wx", mode: 0o400 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await chmod(directory, 0o700);
    });
  }
}
