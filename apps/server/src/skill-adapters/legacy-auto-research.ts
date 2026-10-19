/** Read-only compatibility for pre-grant Auto Research layouts and historical sandbox_run. */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { workspaceFile } from "../storage/persistence.js";
import { canonicalDirectory } from "../runtime/sandbox/policy.js";
import type { SandboxIdentity } from "../runtime/agent/worker/sandbox-tool.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const CANDIDATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export class InvalidSandboxOutput extends Error {}
/** No aliases or symlink components are accepted for candidate data. Hard links are also excluded. */
export async function validateTree(root: string, limit = 4096): Promise<void> {
  let entries = 0;
  const visit = async (path: string): Promise<void> => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (++entries > limit) throw new InvalidSandboxOutput("Sandbox candidate tree exceeds entry limit");
      const file = join(path, item.name); const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new InvalidSandboxOutput("Sandbox candidate contains links or special files");
      if (info.isDirectory()) await visit(file);
    }
  };
  await visit(root);
}
export async function boundCandidate(identity: SandboxIdentity, operationId: string, candidateId: string) {
  if (!CANDIDATE_PATTERN.test(candidateId)) throw new Error("Invalid candidate_id");
  if ((identity.delegatedAgent || identity.executionScope === "candidate" || identity.candidateId) && identity.candidateId !== candidateId) throw new Error("Candidate is not authorized for this child");
  const owner = identity.budgetOperationId ?? operationId;
  const binding = z.object({ researchId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/) }).strict()
    .parse(JSON.parse(await readFile(workspaceFile(identity.cwd, `execution-budget-scopes/${hash(owner)}.json`), "utf8")));
  // A research ID is one literal component, including rejection of '.' and '..'.
  if ([".", ".."].includes(binding.researchId)) throw new Error("Invalid research identity");
  await canonicalDirectory(identity.cwd);
  const directory = await canonicalDirectory(join(identity.cwd, "research", binding.researchId, "candidates", candidateId));
  const input = await canonicalDirectory(join(directory, "input"));
  const work = await canonicalDirectory(join(directory, "work"));
  await validateTree(input);
  return { directory, input, work, researchId: binding.researchId };
}
export async function sandboxCandidate(identity: SandboxIdentity, operationId: string, candidateId: string) {
  const candidate = await boundCandidate(identity, operationId, candidateId);
  await validateTree(candidate.work);
  return candidate;
}

