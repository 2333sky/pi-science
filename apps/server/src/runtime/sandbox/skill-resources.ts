import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configRoot } from "../../storage/persistence.js";
import { executionGrantsDirectory } from "./execution-grants.js";
import { readRegularFile } from "./file-read.js";
import { networkGrantsPath } from "./network-grants.js";
import { canonicalDirectory, identifyPolicy, isWithin, protectedPaths, type SandboxPolicy } from "./policy.js";
import { pathsOverlap, runtimeReadPolicy } from "./read-grants.js";

/** Only trusted callers supply the current Harness skill directories. Nested
 * read allowances reopen these resources beneath .pi, while writes and unsafe
 * descendants remain denied. Confined delegates retain their bound grant. */
export async function skillResourcePolicy(policy: SandboxPolicy, directories: string[]): Promise<SandboxPolicy> {
  if (policy.mode !== "required" || policy.scope !== "workspace" || directories.length === 0) return policy;
  const protectedRoots = [await realpath(configRoot()), await executionGrantsDirectory(), dirname(networkGrantsPath()), ...(await runtimeReadPolicy()).protectedRoots];
  const roots = [...new Set(directories)].sort();
  const denied = [...policy.denyPaths];
  for (const root of roots) {
    await canonicalDirectory(root);
    if (isWithin(root, policy.cwd)) throw new Error("Skill resource grants must not cover the workspace");
    if (protectedRoots.some((protectedRoot) => pathsOverlap(root, protectedRoot))) throw new Error("Skill resources overlap protected service data");
    await readRegularFile(join(root, "SKILL.md"), 1024 * 1024);
    denied.push(...await protectedPaths(root));
  }
  return identifyPolicy({ ...policy,
    readPaths: [...new Set([...policy.readPaths, ...roots])],
    writeDenyPaths: [...new Set([...(policy.writeDenyPaths ?? []), ...roots])],
    denyPaths: [...new Set(denied)].sort(),
  });
}
