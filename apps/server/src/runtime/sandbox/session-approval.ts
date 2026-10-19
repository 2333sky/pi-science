import { BUILTIN_DENIED_DOMAINS } from "./network-grant-state.js";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionApprovalSchema, type ApprovalMode } from "@pi-science/contracts";
import { configRoot, withFileWriteLock, writeJsonAtomic } from "../../storage/persistence.js";
import { readOperatorConfig } from "./operator-config.js";
import type { SandboxPolicy } from "./policy.js";

export async function sessionApprovalPath(cwd: string, sessionId: string): Promise<string> {
  const directory = join(await realpath(configRoot()), "session-permissions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(`${await realpath(cwd)}\0${sessionId}`).digest("hex");
  return join(directory, `${key}.json`);
}
export async function readSessionApproval(cwd: string, sessionId: string) {
  try { return sessionApprovalSchema.parse(await readOperatorConfig(await sessionApprovalPath(cwd, sessionId), 4096)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "ask" as const, revision: 0 }; throw error; }
}
export async function saveSessionApproval(cwd: string, sessionId: string, mode: ApprovalMode, revision: number) {
  const path = await sessionApprovalPath(cwd, sessionId);
  return withFileWriteLock(path, async () => {
    const previous = await readSessionApproval(cwd, sessionId);
    if (previous.revision !== revision) throw new Error("Approval mode changed; reload and retry");
    const next = sessionApprovalSchema.parse({ mode, revision: revision + 1 });
    await writeJsonAtomic(path, next, { mode: 0o600 });
    return next;
  });
}
/** Called only by trusted entry points with their authenticated session identity. */
export async function sessionPolicy(policy: SandboxPolicy, sessionId?: string): Promise<SandboxPolicy> {
  if (!sessionId || policy.scope !== "workspace") return policy;
  const { mode } = await readSessionApproval(policy.cwd, sessionId);
  if (mode === "ask") return policy;
  const home = await realpath(homedir());
  const denied = [...policy.denyPaths, await realpath(configRoot()),
    ...[".ssh", ".aws", ".azure", ".config", ".codex", ".agents", ".gnupg", ".pi-science", "Library/Keychains"].map((name) => join(home, name))];
  return { ...policy, owner: sessionId,
    readPaths: mode === "full" ? [...new Set([...policy.readPaths, home])] : policy.readPaths,
    writePaths: mode === "full" ? [...new Set([...policy.writePaths, home])] : policy.writePaths,
    denyPaths: [...new Set(denied)],
    writeDenyPaths: [...(policy.writeDenyPaths ?? []), fileURLToPath(new URL("../../../../../", import.meta.url)),
      dirname(process.execPath),
      ...(relative(home, process.execPath).startsWith("..") ? [] : [join(home, relative(home, process.execPath).split(/[\\/]/)[0]!)]),
    ],
    network: { mode: "allowlist", allowedDomains: policy.network.mode === "allowlist" ? policy.network.allowedDomains : [],
      httpsOnlyDomains: [...(policy.network.mode === "allowlist" ? policy.network.httpsOnlyDomains ?? [] : []), "*:443"],
      deniedDomains: [...new Set([...BUILTIN_DENIED_DOMAINS, ...(policy.network.mode === "allowlist" ? policy.network.deniedDomains : [])])] },
  };
}
export async function sessionMode(cwd: string, sessionId?: string): Promise<ApprovalMode> {
  return sessionId ? (await readSessionApproval(cwd, sessionId)).mode : "ask";
}
