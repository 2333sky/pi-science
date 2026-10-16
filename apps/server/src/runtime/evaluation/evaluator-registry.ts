import { randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileWriteLock } from "../../storage/persistence.js";
import { canonicalDirectory, isWithin } from "../sandbox/policy.js";
import { evaluatorId, evaluatorRegistrationSchema, evaluatorRevisionSchema, EvaluatorError, type EvaluatorRevision } from "./evaluator-contracts.js";
import { captureEvaluatorTree, readEvaluatorFile, requirePrivateDirectory } from "./evaluator-files.js";

export interface EvaluatorSources { evaluator: string; dataset: string; environment: string }
/** Offline operator API only. Do not instantiate in an Agent Worker or expose through HTTP/tools.
 * Registration freezes assets; it does not certify a runner or enable official scoring. */
export class EvaluatorRegistry {
  constructor(readonly root: string, private readonly untrustedRoots: readonly string[], private readonly runtimeReadRoots: readonly string[] = []) {}

  private async rejectRuntimeOverlap(path: string): Promise<void> {
    // Ordinary srt workloads can read system binaries/libraries. Private assets
    // must not be placed beneath those grants, even when outside a workspace.
    for (const root of ["/usr", "/bin", "/lib", "/lib64", "/dev", "/proc", "/sys", ...this.runtimeReadRoots]) {
      const canonical = await realpath(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" && !this.runtimeReadRoots.includes(root)) return root; throw error; });
      if (isWithin(canonical, path) || isWithin(path, canonical)) throw new Error("Evaluator assets overlap sandbox runtime read grants");
    }
  }

  private async checkRoots(workspace: string): Promise<void> {
    if (process.platform !== "linux") throw new Error("Evaluator registry requires Linux");
    await requirePrivateDirectory(this.root);
    await this.rejectRuntimeOverlap(this.root);
    for (const path of [workspace, ...this.untrustedRoots]) {
      await canonicalDirectory(path);
      if (isWithin(path, this.root) || isWithin(this.root, path)) throw new Error("Evaluator state must be outside Agent workspaces");
    }
  }

  async register(input: unknown, sources: EvaluatorSources): Promise<EvaluatorRevision> {
    const registration = evaluatorRegistrationSchema.parse(input);
    await this.checkRoots(registration.workspace);
    for (const source of Object.values(sources)) {
      await canonicalDirectory(source);
      await this.rejectRuntimeOverlap(source);
      for (const untrusted of [registration.workspace, ...this.untrustedRoots, this.root]) {
        if (isWithin(untrusted, source) || isWithin(source, untrusted)) throw new Error("Evaluator sources overlap untrusted workspace or registry");
      }
    }
    const trees = { evaluator: await captureEvaluatorTree(sources.evaluator), dataset: await captureEvaluatorTree(sources.dataset), environment: await captureEvaluatorTree(sources.environment) };
    const revision = evaluatorRevisionSchema.parse({ ...registration, schemaVersion: 1, registeredAt: new Date().toISOString(), evaluatorCodeDigest: trees.evaluator.digest, protectedDataDigest: trees.dataset.digest, environmentDigest: trees.environment.digest });
    if (Buffer.byteLength(JSON.stringify(revision)) > 256 * 1024) throw new Error("Evaluator manifest exceeds byte limit");
    return withFileWriteLock(join(this.root, "registry"), async () => {
      await this.checkRoots(registration.workspace);
      const destination = join(this.root, registration.id);
      // Reserve the final name first, so neither duplicate registration nor a failed/crashed
      // registration can silently replace a historical revision. Partial revisions fail closed.
      await mkdir(destination, { mode: 0o700 });
      const staging = join(this.root, `.staging-${randomUUID()}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        for (const [name, tree] of Object.entries(trees)) {
          const root = join(staging, name); await mkdir(root, { mode: 0o700 });
          for (const file of tree.files) {
            const path = join(root, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            await writeFile(path, file.bytes, { flag: "wx", mode: file.executable ? 0o500 : 0o400 });
          }
          // Paths under a private parent remain inaccessible to other users, and the
          // sandbox must grant these trees read access only. Rehash before every use.
        }
        await writeFile(join(staging, "manifest.json"), JSON.stringify(revision), { flag: "wx", mode: 0o400 });
        await rename(staging, destination);
        return revision;
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }

  async load(id: string): Promise<EvaluatorRevision> {
    try {
      evaluatorId.parse(id); await requirePrivateDirectory(this.root);
      const directory = join(this.root, id); await canonicalDirectory(directory);
      // No approval cache: revocation is checked on every load, including after hashing.
      const revoked = async () => {
        try { await readEvaluatorFile(join(directory, "revoked.json"), 4096); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      };
      if (await revoked()) throw new Error("Revoked");
      const revision = evaluatorRevisionSchema.parse(JSON.parse((await readEvaluatorFile(join(directory, "manifest.json"), 256 * 1024)).toString("utf8")));
      if (revision.id !== id) throw new Error("Revision identity mismatch");
      await this.checkRoots(revision.workspace);
      for (const [name, expected] of [["evaluator", revision.evaluatorCodeDigest], ["dataset", revision.protectedDataDigest], ["environment", revision.environmentDigest]] as const) {
        if ((await captureEvaluatorTree(join(directory, name))).digest !== expected) throw new Error("Frozen evaluator assets changed");
      }
      if (await revoked()) throw new Error("Revoked");
      return revision;
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
