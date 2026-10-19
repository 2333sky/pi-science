import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { validateManifest } from "./validate-manifest.mjs";

// Skill-owned research decisions only. This never executes experiments or attests
// to Runtime Execution/Artifact existence. SQLite is an OS-released mutex only;
// it holds no research state. JSONL is the sole semantic history after migration.
const queues = new Map();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const fail = (message) => { throw new Error(`Research journal: ${message}`); };
const literal = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id);
async function directory(path) {
  path = resolve(path);
  if (await realpath(path) !== path) fail("directory aliases are forbidden");
  for (let current = path; dirname(current) !== current; current = dirname(current)) if (!(await lstat(current)).isDirectory()) fail("linked directory component");
  return path;
}
async function regular(path, missing = false) {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) fail("requires bounded single-link regular files"); }
  catch (error) { if (!missing || error.code !== "ENOENT") throw error; }
}
async function syncDirectory(path) { if (process.platform === "win32") return; const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
async function atomic(path, bytes) {
  await regular(path, true); const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path); await syncDirectory(dirname(path));
}
async function locked(root, operation) {
  root = await directory(root); const previous = queues.get(root) ?? Promise.resolve();
  let release; const next = new Promise((resolveWait) => { release = resolveWait; }); const pending = previous.then(() => next); queues.set(root, pending);
  await previous;
  let db, began = false;
  try {
    const path = join(root, "research-events.lock.sqlite");
    for (const name of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) await regular(name, true);
    db = new DatabaseSync(path); db.exec("PRAGMA busy_timeout=10000; BEGIN IMMEDIATE"); began = true;
    return await operation(root);
  } finally { try { if (db) { try { if (began) db.exec("ROLLBACK"); } finally { db.close(); } } } finally { release(); if (queues.get(root) === pending) queues.delete(root); } }
}
export function projectResearchEvents(events) {
  let manifest, checkpoint, imported = false; const seen = new Map(), decisions = [];
  for (const event of events) {
    if (!event || event.schema_version !== 1 || !literal(event.event_id) || !(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(event.research_id)) || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) || Object.keys(event).sort().join() !== "event_id,payload,research_id,schema_version,type") fail("invalid event envelope");
    const bytes = canonical(event), previous = seen.get(event.event_id);
    if (previous) { if (previous !== bytes) fail("event ID reused with different content"); continue; }
    seen.set(event.event_id, bytes);
    manifest ??= { schema_version: 1, research_id: event.research_id, revision: 0, candidates: {}, executions: {}, experiments: {} };
    if (manifest.research_id !== event.research_id) fail("mixed research identities");
    const p = structuredClone(event.payload);
    if (event.type === "legacy_imported") {
      if (seen.size !== 1 || imported) fail("legacy import must be the first event");
      if (Object.keys(p).sort().join() !== "manifest,snapshot,source_sha256") fail("invalid legacy import fields");
      validateManifest(p.manifest);
      if (p.manifest.research_id !== event.research_id || !/^[a-f0-9]{64}$/.test(p.source_sha256) || p.snapshot !== `manifest.legacy-${p.source_sha256}.json`) fail("invalid legacy source identity");
      manifest = p.manifest; imported = true;
    } else if (event.type === "candidate_created") {
      if (!literal(p.candidate_id) || Object.hasOwn(manifest.candidates, p.candidate_id) || Object.keys(p).sort().join() !== "candidate_id,hypothesis") fail("invalid or duplicate Candidate creation");
      manifest.candidates[p.candidate_id] = { path: `candidates/${p.candidate_id}`, hypothesis: p.hypothesis };
    } else if (event.type === "execution_linked") {
      if (!/^exec_[A-Za-z0-9_-]+$/.test(p.execution_id) || Object.hasOwn(manifest.executions, p.execution_id) || Object.keys(p).sort().join() !== "artifact_refs,candidate_id,execution_id") fail("invalid or duplicate Execution link");
      manifest.executions[p.execution_id] = { candidate_id: p.candidate_id, artifact_refs: p.artifact_refs };
    } else if (event.type === "experiment_recorded") {
      if (!literal(p.experiment_id) || !p.experiment || Object.keys(p).sort().join() !== "experiment,experiment_id") fail("invalid Experiment decision");
      const previous = manifest.experiments[p.experiment_id];
      if (previous && (previous.status === "completed" || previous.protocol_version !== p.experiment.protocol_version || previous.candidate_id !== p.experiment.candidate_id || previous.result_path !== p.experiment.result_path)) fail("frozen Experiment identity/evaluation cannot be rewritten; use a new Experiment ID");
      manifest.experiments[p.experiment_id] = p.experiment;
    } else if (event.type === "checkpoint_recorded") {
      if (Object.keys(p).sort().join() !== "blockers,next_actions,phase" || typeof p.phase !== "string" || !p.phase.trim() || ![p.next_actions, p.blockers].every((list) => Array.isArray(list) && list.every((item) => typeof item === "string"))) fail("invalid checkpoint decision");
      checkpoint = { event_id: event.event_id, ...p };
    } else if (event.type === "candidate_selected") {
      if (Object.keys(p).sort().join() !== "candidate_id,experiment_id,reason" || typeof p.reason !== "string" || !p.reason.trim() || !Object.hasOwn(manifest.experiments, p.experiment_id) || manifest.experiments[p.experiment_id].candidate_id !== p.candidate_id || manifest.experiments[p.experiment_id].status !== "completed") fail("selection requires a completed linked Experiment and reason");
      decisions.push({ event_id: event.event_id, ...p });
    } else fail("unknown decision event type");
    manifest.revision++; validateManifest(manifest);
  }
  return { manifest, decisions, checkpoint, event_count: seen.size, head: events.length ? hash(canonical(events)) : null };
}
async function readEvents(root) {
  const path = join(root, "research-events.jsonl"); await regular(path, true);
  let bytes; try { bytes = await readFile(path); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (bytes.length && bytes.at(-1) !== 10) fail("incomplete_tail: preserve and recover the uncommitted tail before retrying");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n").slice(0, -1).map((line) => JSON.parse(line));
}
export async function readResearchJournal(root) { return locked(root, async (dir) => projectResearchEvents(await readEvents(dir))); }
async function appendUnlocked(root, events, event) {
  if (Buffer.byteLength(canonical(event)) > (event.type === "legacy_imported" ? 8 * 1024 * 1024 : 64 * 1024)) fail("event exceeds 64 KiB");
  const existing = events.find((item) => item.event_id === event.event_id);
  if (existing) { if (canonical(existing) !== canonical(event)) fail("event ID reused with different content"); return projectResearchEvents(events); }
  const projection = projectResearchEvents([...events, event]);
  const path = join(root, "research-events.jsonl"); await regular(path, true);
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size + Buffer.byteLength(canonical(event)) + 1 > 8 * 1024 * 1024) fail("journal file limit or link violation");
    await handle.writeFile(`${canonical(event)}\n`); await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(root); return projection;
}
export async function appendResearchEvents(root, events) {
  if (!Array.isArray(events) || !events.length || events.length > 1000) fail("batch must contain 1..1000 events");
  return locked(root, async (dir) => {
    const saved = await readEvents(dir); projectResearchEvents([...saved, ...events]);
    let projection;
    for (const event of events) { projection = await appendUnlocked(dir, saved, event); if (!saved.some((item) => item.event_id === event.event_id)) saved.push(event); }
    return projection;
  });
}
export async function appendResearchEvent(root, event) { return appendResearchEvents(root, [event]); }
export async function rebuildResearchManifest(root) {
  return locked(root, async (dir) => { const projection = projectResearchEvents(await readEvents(dir)); if (!projection.manifest) fail("empty journal has no Manifest"); await atomic(join(dir, "manifest.json"), `${JSON.stringify(projection.manifest, null, 2)}\n`); return projection; });
}
export async function importLegacyManifest(root) {
  return locked(root, async (dir) => {
    const events = await readEvents(dir);
    if (events.length) { if (events[0].type === "legacy_imported") return projectResearchEvents(events); fail("cannot import over an existing decision history"); }
    const source = join(dir, "manifest.json"); await regular(source);
    const bytes = await readFile(source), manifest = validateManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const sha = hash(bytes), snapshot = `manifest.legacy-${sha}.json`, path = join(dir, snapshot);
    await regular(path, true);
    try { await readFile(path).then((saved) => { if (!saved.equals(bytes)) fail("legacy snapshot identity mismatch"); }); }
    catch (error) { if (error.code !== "ENOENT") throw error; const handle = await open(path, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await syncDirectory(dir); }
    return appendUnlocked(dir, events, { schema_version: 1, event_id: `legacy-${sha}`, research_id: manifest.research_id, type: "legacy_imported", payload: { manifest, source_sha256: sha, snapshot } });
  });
}
/** Only an unterminated final record is uncommitted. Preserve its exact bytes,
 * never discard malformed newline-committed records or rewrite valid history. */
export async function recoverResearchTail(root) {
  return locked(root, async (dir) => {
    const path = join(dir, "research-events.jsonl"); await regular(path); const bytes = await readFile(path);
    if (!bytes.length || bytes.at(-1) === 10) return { recovered: false };
    const boundary = bytes.lastIndexOf(10) + 1, prefix = bytes.subarray(0, boundary), tail = bytes.subarray(boundary);
    projectResearchEvents(new TextDecoder("utf-8", { fatal: true }).decode(prefix).split("\n").slice(0, -1).map((line) => JSON.parse(line)));
    const backup = `research-events.tail-${hash(tail)}.txt`; await regular(join(dir, backup), true);
    await atomic(join(dir, backup), tail);
    const handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW); try { await handle.truncate(boundary); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(dir); return { recovered: true, backup, bytes: tail.length };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, root, eventPath] = process.argv.slice(2);
    if (!root) fail("usage: research-journal.mjs append|rebuild|import|recover-tail|inspect <study-directory> [event.json]");
    const result = command === "append" && eventPath ? await (async () => { await directory(dirname(resolve(eventPath))); await regular(resolve(eventPath)); const value = JSON.parse(await readFile(eventPath, "utf8")); return appendResearchEvents(root, Array.isArray(value) ? value : [value]); })() : command === "rebuild" ? await rebuildResearchManifest(root) : command === "import" ? await importLegacyManifest(root) : command === "recover-tail" ? await recoverResearchTail(root) : command === "inspect" ? await readResearchJournal(root) : fail("invalid command");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
