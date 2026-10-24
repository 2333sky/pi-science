import { readSandboxFile } from "../../sandbox/artifacts.js";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ok, type AgentHarnessTool, type NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { withFileWriteLock, workspaceFile } from "../../../storage/persistence.js";
import { isWithin } from "../../sandbox/policy.js";
import { executionGrantPolicy } from "../../sandbox/execution-grants.js";
import type { ExecutionScope } from "../agent-runtime-types.js";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) => path !== root && !relative(root, path).startsWith("..") && !isAbsolute(relative(root, path));
export interface SandboxIdentity { cwd: string; sessionId: string; budgetOperationId?: string; candidateId?: string; budgetNodeId?: string; executionGrantId?: string; executionScope?: ExecutionScope; delegatedAgent?: string }

/** Keep the restricted worker's existing read capability inside its assigned candidate as well. */
export function confinedReadTool(original: Tool, identity: SandboxIdentity): Tool {
  if (!identity.executionGrantId && !identity.candidateId && identity.executionScope !== "candidate" && identity.executionScope !== "confined") return original;
  return { ...original, async execute(id, params, update, ctx, invocation, context) {
    if (!identity.executionGrantId) throw new Error("Candidate read requires a bound candidate_id and server-bound execution grant; use supplied task text for code generation");
    const initial = await executionGrantPolicy(identity, undefined, "read");
    const lock = workspaceFile(identity.cwd, `sandbox-candidates/${hash(initial.cwd)}.json`);
    return withFileWriteLock(lock, async () => {
      context.abortSignal?.throwIfAborted();
      const policy = await executionGrantPolicy(identity, undefined, "read");
      const values = params as { path: string };
      const path = resolve(identity.cwd, values.path);
      if (!policy.readPaths.some((root) => inside(root, path)) || policy.denyPaths.some((root) => isWithin(root, path)) || await realpath(path) !== path) throw new Error("Read is outside the assigned candidate");
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_READ_BYTES) throw new Error("Candidate read requires a bounded regular file");
      if (!["linux", "darwin"].includes(process.platform)) return original.execute(id, { ...values, path }, update, ctx, invocation, context);
      const bytes = await readSandboxFile(policy, path);
      const env = new Proxy(ctx.env, { get(target, property) {
        if (property === "readBinaryFile") return async (requested: string) => { if (resolve(identity.cwd, requested) !== path) throw new Error("Read is outside the assigned candidate"); return ok(bytes); };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      return original.execute(id, { ...values, path }, update, { ...ctx, env }, invocation, context);
    });
  } };
}

