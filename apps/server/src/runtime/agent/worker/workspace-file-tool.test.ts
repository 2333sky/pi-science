import { createReadTool, createWriteTool, BACKGROUND_CONTEXT, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { workspaceFileTool } from "./workspace-file-tool.js";
let root: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
it.skipIf(process.platform !== "linux")("permits workspace files and readonly skills but refuses private roots, escapes and linked reads/writes", async () => {
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "file-boundary-"));
  const cwd = join(root, "workspace"); const privateRoot = join(root, "private"); const skillRoot = join(root, "skills");
  for (const path of [cwd, privateRoot, skillRoot]) await mkdir(path, { mode: 0o700 });
  const secret = join(privateRoot, "labels.json"); await writeFile(secret, "SECRET"); await writeFile(join(skillRoot, "SKILL.md"), "protocol");
  const policy = join(privateRoot, "policy.json"); await writeFile(policy, JSON.stringify({ schemaVersion: 1, dependencyRoots: [], protectedRoots: [privateRoot] }), { mode: 0o600 }); vi.stubEnv("PI_SCIENCE_SANDBOX_READ_POLICY", policy);
  const env = new NodeExecutionEnv({ cwd }); const read = workspaceFileTool(createReadTool(), cwd, [skillRoot]); const write = workspaceFileTool(createWriteTool(), cwd, [skillRoot]);
  const invocation = { operationId: "op", invocationId: "call", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} };
  const call = (tool: typeof read, path: string) => tool.execute("call", { path, content: "updated" }, () => {}, { env }, invocation, BACKGROUND_CONTEXT);
  await call(write, "research/study/evaluation.yaml"); expect(await readFile(join(cwd, "research/study/evaluation.yaml"), "utf8")).toBe("updated");
  expect(JSON.stringify(await call(read, join(skillRoot, "SKILL.md")))).toContain("protocol");
  await expect(call(write, join(skillRoot, "SKILL.md"))).rejects.toThrow("outside");
  for (const tool of [read, write]) {
    await expect(call(tool, secret)).rejects.toThrow("Protected"); await expect(call(tool, "../escape")).rejects.toThrow("outside"); await expect(call(tool, ".pi-science/state.json")).rejects.toThrow("outside");
  }
  await symlink(secret, join(cwd, "alias.json"));
  await expect(call(read, "alias.json")).rejects.toThrow(); await expect(call(write, "alias.json")).rejects.toThrow();
  await symlink(privateRoot, join(cwd, "alias-dir")); await expect(call(write, "alias-dir/labels.json")).rejects.toThrow();
  expect(await readFile(secret, "utf8")).toBe("SECRET"); await env.cleanup(BACKGROUND_CONTEXT);
});
