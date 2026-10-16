import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { ok, type AgentHarnessTool, type NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { canonicalDirectory, isWithin } from "../../sandbox/policy.js";
import { runtimeReadPolicy, pathsOverlap } from "../../sandbox/read-grants.js";
import { readEvaluatorFile } from "../../evaluation/evaluator-files.js";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;
/** Tools may manage research protocol/candidate files, but never service-private
 * state, evaluator assets or aliases escaping the workspace. Skill roots are read-only. */
export function workspaceFileTool(original: Tool, cwd: string, skillRoots: string[]): Tool {
  return { ...original, async execute(id, params, update, ctx, invocation, context) {
    const protectedRoots = (await runtimeReadPolicy()).protectedRoots;
    const check = (path: string, write = false) => {
      path = resolve(cwd, path);
      if (write && pathsOverlap(fileURLToPath(new URL("../../../../", import.meta.url)), path)) throw new Error("Trusted server installation is not writable by file tools");
      if (protectedRoots.some((root) => pathsOverlap(root, path))) throw new Error("Protected service data is unavailable to file tools");
      if ((!isWithin(cwd, path) && (write || !skillRoots.some((root) => isWithin(root, path)))) || relative(cwd, path).split(/[\\/]/).some((part) => [".pi-science", ".git", "node_modules"].includes(part))) throw new Error("File access is outside authorized workspace data");
      return path;
    };
    check(String((params as { path?: string }).path ?? ""), original.name !== "read");
    const env = new Proxy(ctx.env, { get(target, property) {
      if (["readBinaryFile", "readTextFile"].includes(String(property))) return async (requested: string) => {
        const path = check(requested);
        const bytes = process.platform === "linux" ? await readEvaluatorFile(path, 16 * 1024 * 1024) : await readFile(await realpath(path).then((canonical) => check(canonical)));
        return ok(property === "readTextFile" ? bytes.toString("utf8") : bytes);
      };
      if (property === "writeFile") return async (requested: string, bytes: string | Uint8Array) => {
        const path = check(requested, true);
        if (process.platform !== "linux") { await mkdir(dirname(path), { recursive: true }); check(await realpath(dirname(path)), true); return target.writeFile(path, bytes, context); }
        await canonicalDirectory(cwd);
        const parts = relative(cwd, path).split("/"); const handles: FileHandle[] = [];
        try {
          let parent = await open(cwd, constants.O_RDONLY | constants.O_DIRECTORY); handles.push(parent);
          for (const part of parts.slice(0, -1)) {
            const child = `/proc/self/fd/${parent.fd}/${part}`; await mkdir(child).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
            parent = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(parent);
          }
          const file = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); handles.push(file);
          const info = await file.stat(); if (!info.isFile() || info.nlink !== 1) throw new Error("Writes require a single-link regular workspace file");
          context.abortSignal?.throwIfAborted(); await file.truncate(0); await file.writeFile(bytes); return ok(undefined);
        } finally { for (const handle of handles.reverse()) await handle.close(); }
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return original.execute(id, params, update, { ...ctx, env }, invocation, context);
  } };
}
