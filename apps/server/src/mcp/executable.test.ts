import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveMcpExecutable } from "./executable.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await realpath(await mkdtemp(join(tmpdir(), "mcp-executable-"))); roots.push(root); const cwd = join(root, "workspace"); await mkdir(cwd); return { root, cwd }; }
it.skipIf(process.platform === "win32")("finds Node package commands outside system directories without relying on sandbox PATH", async () => {
  const { root, cwd } = await fixture(); const bin = join(root, "bin"); const pkg = join(root, "npm");
  await mkdir(bin); await mkdir(pkg); await writeFile(join(pkg, "package.json"), "{}");
  const script = join(pkg, "npx-cli.js"); await writeFile(script, "#!/usr/bin/env node\nconsole.log('test')\n", { mode: 0o755 });
  await symlink(script, join(bin, "npx"));
  const result = await resolveMcpExecutable("npx", cwd, bin);
  expect(result.executable).toBe(await realpath(process.execPath)); expect(result.prefix).toEqual([script]); expect(result.dependencies).toContain(pkg);
});
it.skipIf(process.platform === "win32")("never resolves workspace executables or relative PATH entries", async () => {
  const { cwd } = await fixture(); const script = join(cwd, "uvx"); await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await expect(resolveMcpExecutable("uvx", cwd, `${cwd}:.`)).rejects.toThrow("outside the writable workspace");
  await expect(resolveMcpExecutable("./uvx", cwd, cwd)).rejects.toThrow("absolute path or a bare");
});
it.skipIf(process.platform === "win32")("preserves uvx behavior when its symlink resolves to uv", async () => {
  const { root, cwd } = await fixture(); const uv = join(root, "uv"); await writeFile(uv, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); await symlink(uv, join(root, "uvx"));
  expect((await resolveMcpExecutable("uvx", cwd, root)).prefix).toEqual(["tool", "run"]);
  await chmod(uv, 0o644); await expect(resolveMcpExecutable("uvx", cwd, root)).rejects.toThrow("unavailable");
});
