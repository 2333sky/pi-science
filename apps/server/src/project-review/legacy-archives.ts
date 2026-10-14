import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { metadataRoot, withFileWriteLock, writeJsonAtomic } from "../storage/persistence.js";
import { pathIsInside } from "../support/platform-utils.js";
import { resolveWorkspaceFile } from "../security/workspace-security.js";

export interface LegacyRecord { record_id?: string; record_type: string; loop_id?: string; candidate_id?: string; created_at?: string; payload: Record<string, unknown> }
/** Compatibility reader only. Never schedules, changes legacy status or rewrites the original log. */
export async function legacyMemoryRecords(cwd: string): Promise<LegacyRecord[]> {
  const root = metadataRoot(cwd); const path = join(root, "research-records-v2.jsonl");
  let info;
  try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || (await lstat(root)).isSymbolicLink()) throw new Error("Legacy archive source must be a regular metadata file");
  const records: LegacyRecord[] = [];
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: LegacyRecord; try { row = JSON.parse(line); } catch { continue; /* retain the original torn tail on disk */ }
    if (row && typeof row.record_type === "string" && row.payload && typeof row.payload === "object") records.push(row);
  }
  return records;
}
export async function legacyArchives(cwd: string) {
  const records = await legacyMemoryRecords(cwd);
  const groups = new Map<string, LegacyRecord[]>();
  for (const row of records) if (row.loop_id) { const rows = groups.get(row.loop_id) ?? []; rows.push(row); groups.set(row.loop_id, rows); }
  const archives = [];
  const evaluators = records.filter((row) => row.record_type.startsWith("evaluator."));
  for (const [id, rows] of groups) {
    // Last stored metadata is a historical display, not a live state machine.
    const description = Object.assign({}, ...rows.filter((row) => row.record_type.startsWith("loop.")).map((row) => row.payload));
    const digest = createHash("sha256").update(JSON.stringify({ records: rows, evaluators })).digest("hex");
    const directory = `research/archives/${createHash("sha256").update(id).digest("hex").slice(0, 20)}`;
    const path = `${directory}/history-${digest.slice(0, 16)}.json`;
    const target = await archiveExportPath(cwd, path);
    await withFileWriteLock(target, async () => {
      // Serialize the whole export: a concurrent request must not publish a
      // manifest while another request is still copying a referenced result.
      if (await readFile(target, "utf8").catch(() => null) !== null) return;
      const files = await exportLegacyFiles(cwd, directory, rows);
      await writeJsonAtomic(target, { source: "research-records-v2.jsonl", legacy_id: id, digest,
        continuation: "Resume with auto-research in Conversation; legacy scheduling is retired.", records: rows,
        exported_files: files, evaluators });
    });
    archives.push({ id, title: String(description.title ?? id), objective: String(description.objective ?? ""), status: String(description.status ?? "unknown"), path, record_count: rows.length });
  }
  return archives;
}

/** Export only referenced solutions/runs from the trusted storage root. Refuse symlinks at either end. */
async function exportLegacyFiles(cwd: string, directory: string, rows: LegacyRecord[]) {
  const files: Array<{ original_path: string; path: string }> = [];
  const roots = new Set<string>();
  const stateRoot = metadataRoot(cwd);
  for (const row of rows) {
    const solution = row.record_type === "candidate.proposed" ? (row.payload.solution as { path?: string } | undefined)?.path : undefined;
    const outputs = row.record_type === "candidate.execution_started" ? row.payload.outputs_dir : undefined;
    const input = typeof solution === "string" ? resolve(cwd, solution) : typeof outputs === "string" ? dirname(resolve(cwd, outputs)) : undefined;
    if (input && (pathIsInside(join(stateRoot, "solutions"), input) || pathIsInside(join(stateRoot, "runs"), input))) roots.add(input);
  }
  const canonicalState = await realpath(stateRoot).catch(() => stateRoot);
  const visit = async (source: string, destination: string): Promise<void> => {
    const info = await lstat(source).catch(() => null);
    if (!info || info.isSymbolicLink() || !pathIsInside(canonicalState, await realpath(source))) return;
    const target = await archiveExportPath(cwd, destination);
    if ((await lstat(target).catch(() => null))?.isSymbolicLink()) throw new Error("Archive export must not traverse symlinks");
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true });
      for (const entry of await readdir(source)) await visit(join(source, entry), `${destination}/${entry}`);
    } else if (info.isFile()) {
      await mkdir(dirname(target), { recursive: true });
      // COPYFILE_EXCL keeps an existing exported result intact.
      await copyFile(source, target, 1).catch((error) => { if (error.code !== "EEXIST") throw error; });
      files.push({ original_path: relative(cwd, source).replaceAll("\\", "/"), path: destination });
    }
  };
  for (const root of roots) await visit(root, `${directory}/files/${createHash("sha256").update(relative(stateRoot, root)).digest("hex").slice(0, 16)}`);
  return files;
}

async function archiveExportPath(cwd: string, path: string): Promise<string> {
  const target = await resolveWorkspaceFile(cwd, path);
  let current = cwd;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    if ((await lstat(current).catch(() => null))?.isSymbolicLink()) throw new Error("Archive export must not traverse symlinks");
  }
  return target;
}
