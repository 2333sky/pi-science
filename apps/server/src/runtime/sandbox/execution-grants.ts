import { ExecutionBudgetLedger } from "../executions/execution-budget.js";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { configRoot, withFileWriteLock, writeJsonAtomic } from "../../storage/persistence.js";
import { canonicalDirectory, identifyPolicy, isWithin, isSensitiveWorkspaceName, protectedPaths, type SandboxPolicy } from "./policy.js";
import { profileConfiguration } from "./profiles.js";
import { readBudget } from "../executions/execution-budget.js";
import { pathsOverlap, runtimeReadPolicy } from "./read-grants.js";

/** Requested paths are untrusted selections, never serialized SandboxPolicy. */
export const executionSelectionSchema = z.object({ cwd: z.string().min(1), read_paths: z.array(z.string().min(1)).max(8), write_paths: z.array(z.string().min(1)).min(1).max(8) }).strict();
export type ExecutionSelection = z.infer<typeof executionSelectionSchema>;
const rootSchema = z.object({ path: z.string(), dev: z.string(), ino: z.string() }).strict();
const grantSchema = z.object({ version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), workspace: z.string(), workerKey: z.string(), budgetOwner: z.string(), parentId: z.string().regex(/^[a-f0-9]{64}$/).optional(), deadline: z.number().finite(), tools: z.array(z.string()), denyPaths: z.array(z.string()), configSources: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()), cwd: z.string(), reads: z.array(rootSchema), writes: z.array(rootSchema), revoked: z.boolean() }).strict();
export type ExecutionGrant = z.infer<typeof grantSchema>;
export interface ExecutionGrantIdentity { cwd: string; sessionId: string; budgetOperationId?: string; budgetNodeId?: string; executionGrantId?: string }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export async function executionGrantsDirectory() {
  const directory = join(await realpath(configRoot()), "execution-grants");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory || process.platform !== "win32" && (info.uid !== process.getuid!() || info.mode & 0o077)) throw new Error("Execution grants require a private service-owned directory");
  return directory;
}
async function grantPath(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid execution grant identity");
  return join(await executionGrantsDirectory(), `${id}.json`);
}
async function rootIdentity(path: string) {
  await canonicalDirectory(path); const info = await lstat(path, { bigint: true });
  return { path, dev: String(info.dev), ino: String(info.ino) };
}
/** Reject linked/special inputs and outputs before using them as authority. */
export async function validateGrantTree(root: string) {
  const { readdir } = await import("node:fs/promises"); let count = 0;
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++count > 4096) throw new Error("Execution grant tree exceeds entry limit");
      const next = join(path, entry.name), info = await lstat(next);
      if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error("Execution grant contains links or special files");
      if (info.isDirectory()) await visit(next);
    }
  }; await visit(root);
}
async function readGrant(id: string) {
  const path = await grantPath(id), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 || process.platform !== "win32" && (info.uid !== process.getuid!() || info.mode & 0o077)) throw new Error("Invalid private execution grant file");
  const bytes = await readFile(path), grant = grantSchema.parse(JSON.parse(bytes.toString()));
  for (const source of grant.configSources) if (hash(await readFile(source.path, "utf8")) !== source.sha256) throw new Error("Execution grant operator authority changed");
  if (grant.id !== id || grant.revoked || grant.deadline <= Date.now()) throw new Error("Execution grant revoked or expired");
  return { grant, source: { path, sha256: hash(bytes.toString()) } };
}
/** A confined policy grants no access to siblings. Scan only accessible trees,
 * but still deny sensitive ancestors between each root and the workspace.
 * No results are cached: newly protected files and current operator roots apply
 * on every authorization, alongside root identities, grant sources and budgets. */
async function grantProtectedPaths(workspace: string, roots: string[]) {
  const denied = new Set<string>();
  for (const root of roots) {
    if (isWithin(workspace, root)) {
      for (let path = root; path !== workspace; path = dirname(path)) {
        if (isSensitiveWorkspaceName(basename(path))) denied.add(path);
      }
    }
    for (const path of await protectedPaths(root)) denied.add(path);
  }
  return [...denied].sort();
}
export async function executionGrantPolicy(identity: ExecutionGrantIdentity, revision?: string, tool?: string) {
  if (!identity.executionGrantId) throw new Error("Confined execution requires a server-bound execution grant");
  const { grant, source } = await readGrant(identity.executionGrantId);
  if (grant.workspace !== identity.cwd || grant.workerKey !== (identity.budgetNodeId ?? identity.sessionId) || grant.budgetOwner !== identity.budgetOperationId) throw new Error("Execution grant Worker/budget binding mismatch");
  if (tool && !grant.tools.includes(tool) && !(tool === "notebook_read" && grant.tools.includes("notebook_run"))) throw new Error("Tool is outside execution grant ceiling");
  const ledger = new ExecutionBudgetLedger(identity.cwd, grant.budgetOwner, true, grant.workerKey);
  const budget = await ledger.status();
  if (budget.cancelled || budget.deadline <= Date.now()) throw new Error("Execution grant budget cancelled or expired");
  const budgetPath = await ledger.path();
  if (grant.writes.some((root) => isWithin(root.path, budgetPath))) throw new Error("Execution grant overlaps its service-owned budget");
  const sources = [source, ...grant.configSources]; let parentId = grant.parentId; const seen = new Set([grant.id]);
  while (parentId) {
    if (seen.has(parentId) || seen.size > 8) throw new Error("Invalid execution grant ancestry"); seen.add(parentId);
    const parent = await readGrant(parentId); sources.push(parent.source, ...parent.grant.configSources); parentId = parent.grant.parentId;
  }
  for (const root of [...grant.reads, ...grant.writes]) {
    if (JSON.stringify(await rootIdentity(root.path)) !== JSON.stringify(root)) throw new Error("Execution grant root identity changed");
    await validateGrantTree(root.path);
  }
  const workspaceDenies = [...grant.denyPaths, ...await grantProtectedPaths(identity.cwd, [...new Set([...grant.reads, ...grant.writes].map((root) => root.path))])];
  const protectedRoots = [...(await runtimeReadPolicy()).protectedRoots, await realpath(configRoot())];
  for (const root of [...grant.reads, ...grant.writes]) if (workspaceDenies.some((denied) => isWithin(denied, root.path)) || protectedRoots.some((denied) => pathsOverlap(root.path, denied))) throw new Error("Execution grant overlaps protected paths");
  return identifyPolicy({ mode: "required", scope: "confined", cwd: grant.cwd, readPaths: [...new Set([...grant.reads, ...grant.writes].map((root) => root.path))], writePaths: grant.writes.map((root) => root.path), denyPaths: [...workspaceDenies, ...protectedRoots], network: { mode: "none" }, owner: identity.sessionId,
    executionGrant: { id: grant.id, sources, deadline: Math.min(grant.deadline, budget.deadline), budget: { path: budgetPath, nodeId: grant.workerKey, ownerHash: hash(grant.budgetOwner) } }, ...(revision ? { environmentRevision: revision } : {}) });
}
/** Called by authenticated parent dispatch only. Selection must narrow the parent's existing authority. */
export async function createExecutionGrant(input: { workspace: string; workerKey: string; budgetOwner: string; deadline: number; tools: string[]; selection: ExecutionSelection; parentPolicy: SandboxPolicy; parentId?: string }) {
  const selection = executionSelectionSchema.parse(input.selection);
  const normalize = async (path: string) => canonicalDirectory(resolve(input.workspace, path));
  const cwd = await normalize(selection.cwd), reads = await Promise.all(selection.read_paths.map(normalize)), writes = await Promise.all(selection.write_paths.map(normalize));
  if (writes.some((path, index) => writes.some((other, offset) => index !== offset && pathsOverlap(path, other)))) throw new Error("Writable execution grant roots must be disjoint");
  if (!writes.includes(cwd) || reads.some((read) => writes.some((write) => pathsOverlap(read, write)))) throw new Error("Execution grant cwd must be writable and input/output roots disjoint");
  for (const path of [...reads, ...writes]) {
    if (!input.parentPolicy.readPaths.some((root) => isWithin(root, path)) || writes.includes(path) && !input.parentPolicy.writePaths.some((root) => isWithin(root, path)) || input.parentPolicy.denyPaths.some((root) => isWithin(root, path))) throw new Error("Execution grant exceeds parent filesystem authority");
  }
  const denied = [...input.parentPolicy.denyPaths, ...await protectedPaths(input.workspace)];
  const privileged = [...(await runtimeReadPolicy()).protectedRoots, await realpath(configRoot())];
  for (const root of [...reads, ...writes]) {
    if (denied.some((path) => isWithin(path, root)) || privileged.some((path) => pathsOverlap(root, path))) throw new Error("Execution grant overlaps protected paths");
    await validateGrantTree(root);
  }
  if (input.parentId) {
    const parent = (await readGrant(input.parentId)).grant;
    if (parent.workspace !== input.workspace || parent.budgetOwner !== input.budgetOwner || input.deadline > parent.deadline || input.tools.some((tool) => !parent.tools.includes(tool))) throw new Error("Execution grant exceeds parent tool/deadline ceiling");
    for (const path of [...reads, ...writes]) if (![...parent.reads, ...parent.writes].some((root) => isWithin(root.path, path)) || writes.includes(path) && !parent.writes.some((root) => isWithin(root.path, path))) throw new Error("Execution grant exceeds persisted parent filesystem authority");
    const ledger = new ExecutionBudgetLedger(input.workspace, input.budgetOwner, true, input.workerKey);
    const saved = await readBudget(await ledger.path()); let ancestor = saved?.nodes?.[input.workerKey]?.parent; const seen = new Set<string>();
    while (ancestor && ancestor !== parent.workerKey) { if (seen.has(ancestor)) throw new Error("Invalid child budget ancestry"); seen.add(ancestor); ancestor = saved?.nodes?.[ancestor]?.parent; }
    if (ancestor !== parent.workerKey) throw new Error("Execution grant must inherit its parent's budget subtree");
  }
  const budget = await new ExecutionBudgetLedger(input.workspace, input.budgetOwner, true, input.workerKey).status();
  if (budget.cancelled || input.deadline > budget.deadline) throw new Error("Execution grant exceeds active task budget");
  const configFiles = [(await profileConfiguration()).file, (await runtimeReadPolicy()).file].filter((path): path is string => !!path);
  const configSources = await Promise.all([...new Set(configFiles)].map(async (path) => ({ path, sha256: hash(await readFile(path, "utf8")) })));
  if (configSources.some(({ path }) => writes.some((root) => pathsOverlap(root, path)))) throw new Error("Execution grant overlaps operator configuration");
  const denyPaths = input.parentPolicy.denyPaths.filter((path) => [...reads, ...writes].some((root) => pathsOverlap(root, path)));
  const id = hash(JSON.stringify([input.workspace, input.workerKey]));
  const grant = grantSchema.parse({ version: 1, id, workspace: input.workspace, workerKey: input.workerKey, budgetOwner: input.budgetOwner, ...(input.parentId ? { parentId: input.parentId } : {}), deadline: input.deadline, tools: [...new Set(input.tools)].sort(), denyPaths, configSources, cwd, reads: await Promise.all([...new Set(reads)].sort().map(rootIdentity)), writes: await Promise.all([...new Set(writes)].sort().map(rootIdentity)), revoked: false });
  const path = await grantPath(id);
  if ([...reads, ...writes].some((root) => pathsOverlap(root, dirname(path)))) throw new Error("Execution grant overlaps its private ledger");
  await withFileWriteLock(path, async () => {
    let existing: ExecutionGrant | undefined;
    try { existing = (await readGrant(id)).grant; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing && JSON.stringify(existing) !== JSON.stringify(grant)) throw new Error("Execution grant authority cannot change on recovery");
    if (!existing) await writeJsonAtomic(path, grant, { mode: 0o600 });
  });
  const identity = { cwd: input.workspace, sessionId: input.workerKey, budgetNodeId: input.workerKey, budgetOperationId: input.budgetOwner, executionGrantId: id };
  await executionGrantPolicy(identity);
  return id;
}
export async function revokeExecutionGrant(id: string) {
  const path = await grantPath(id);
  await withFileWriteLock(path, async () => { const { grant } = await readGrant(id); await writeJsonAtomic(path, { ...grant, revoked: true }, { mode: 0o600 }); });
}
export async function assertExecutionGrantTool(identity: ExecutionGrantIdentity, tool: string) {
  await executionGrantPolicy(identity);
  if (!(await readGrant(identity.executionGrantId!)).grant.tools.includes(tool)) throw new Error("Tool is outside execution grant ceiling");
}
