import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverAgentDefinitions, resolveAgentDefinition, childToolAllowance } from "./agent-definitions.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function workspace() { const cwd = await mkdtemp(join(tmpdir(), "agent-definitions-")); roots.push(cwd); return cwd; }
async function put(cwd: string, path: string, content: string) { const file = join(cwd, path); await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, content); }
it("resolves project aliases and skill namespaces without collisions, with project skill precedence", async () => {
  const cwd = await workspace();
  await put(cwd, ".pi/agents/reviewer.md", "---\nname: reviewer\ntools: [read, write]\n---\nProject review");
  await put(cwd, ".pi/agents/alias.md", "---\nname: auditor\npackage: science-tools\n---\nAliased review");
  await put(cwd, ".pi/skills/auto-research/SKILL.md", "---\nname: auto-research\ndescription: Research\nlicense: Apache-2.0\n---\nProtocol");
  await put(cwd, ".pi/skills/auto-research/agents/reviewer.md", "---\nname: reviewer\ntools: [read, mcp__search, ask_user_question]\n---\nLocal review");
  expect(await resolveAgentDefinition(cwd, "reviewer")).toMatchObject({ prompt: "Project review", source: "project" });
  expect(await resolveAgentDefinition(cwd, "science-tools.auditor")).toMatchObject({ prompt: "Aliased review" });
  expect(await resolveAgentDefinition(cwd, "auto-research/reviewer")).toMatchObject({ prompt: "Local review", source: "skill" });
  expect(childToolAllowance(["read", "write", "mcp__search", "ask_user_question"], ["read", "mcp__search", "ask_user_question"])).toEqual(["read"]);
  await expect(resolveAgentDefinition(cwd, "auto-research/reviewer", { mode: "none" })).rejects.toThrow("disabled");
  await expect(resolveAgentDefinition(cwd, "auto-research/reviewer", { mode: "denylist", skills: ["auto-research"] })).rejects.toThrow("disabled");
  await expect(resolveAgentDefinition(cwd, "missing/reviewer")).rejects.toThrow("disabled");
  for (const name of ["../reviewer", "auto-research/../../x", "/reviewer", "a/b/c"]) await expect(resolveAgentDefinition(cwd, name)).rejects.toThrow("Invalid");
});
it("does not follow project agent or skill-agent symlinks outside the workspace", async () => {
  const cwd = await workspace(); const outside = await workspace();
  await put(outside, "agents/foreign.md", "Foreign instructions");
  await mkdir(join(cwd, ".pi"), { recursive: true }); await symlink(join(outside, "agents"), join(cwd, ".pi/agents"));
  expect((await discoverAgentDefinitions(cwd)).some((agent) => agent.name === "foreign")).toBe(false);
  await put(cwd, ".pi/skills/safe/SKILL.md", "---\nname: safe\ndescription: Safe\nlicense: Apache-2.0\n---\nSafe");
  await symlink(join(outside, "agents"), join(cwd, ".pi/skills/safe/agents"));
  expect((await discoverAgentDefinitions(cwd)).some((agent) => agent.name === "safe/foreign")).toBe(false);
});
