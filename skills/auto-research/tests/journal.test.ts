import { mkdtemp, realpath, writeFile, readFile, rm, appendFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { appendResearchEvent, rebuildResearchManifest, readResearchJournal, projectResearchEvents, importLegacyManifest, recoverResearchTail } from "../scripts/research-journal.mjs";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await realpath(await mkdtemp(join(tmpdir(), "research-journal-"))); roots.push(root); return root; }
const event = (id: string, candidate = id) => ({ schema_version: 1, event_id: id, research_id: "study.v1", type: "candidate_created", payload: { candidate_id: candidate, hypothesis: "An auditable hypothesis" } });
it("appends idempotently and rebuilds a disposable Manifest without copied execution facts", async () => {
  const root = await directory();
  await Promise.all([appendResearchEvent(root, event("one")), appendResearchEvent(root, event("two")), appendResearchEvent(root, event("one"))]);
  const history = await readFile(join(root, "research-events.jsonl"), "utf8");
  expect(history.trim().split("\n")).toHaveLength(2);
  expect(await appendResearchEvent(root, event("one"))).toMatchObject({ event_count: 2 });
  await expect(appendResearchEvent(root, { ...event("one"), payload: { candidate_id: "changed", hypothesis: "conflict" } })).rejects.toThrow("different content");
  await writeFile(join(root, "manifest.json"), "corrupt derived index");
  const projected = await rebuildResearchManifest(root);
  expect(JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))).toEqual(projected.manifest);
  expect(projected.manifest.revision).toBe(2);
  expect(await readFile(join(root, "research-events.jsonl"), "utf8")).toBe(history);
});
it("preserves and explicitly recovers only an uncommitted torn tail before retry", async () => {
  const root = await directory(); await appendResearchEvent(root, event("one"));
  await appendFile(join(root, "research-events.jsonl"), '{"schema_version":1,"event_id":"two');
  await expect(appendResearchEvent(root, event("two"))).rejects.toThrow("incomplete_tail");
  const recovered = await recoverResearchTail(root);
  expect(recovered.recovered).toBe(true);
  expect(await readFile(join(root, recovered.backup), "utf8")).toContain('"event_id":"two');
  expect(await appendResearchEvent(root, event("two"))).toMatchObject({ event_count: 2 });
  await appendFile(join(root, "research-events.jsonl"), 'malformed committed line\n');
  await expect(rebuildResearchManifest(root)).rejects.toThrow();
  expect(await recoverResearchTail(root)).toEqual({ recovered: false });
});
it("imports legacy state once, preserves its exact bytes and makes the index rebuildable", async () => {
  const root = await directory(); const legacy = { schema_version: 1, research_id: "study.v1", revision: 9, candidates: { old: { path: "candidates/old", hypothesis: "Historical" } }, executions: {}, experiments: {} };
  const bytes = JSON.stringify(legacy, null, 2); await writeFile(join(root, "manifest.json"), bytes);
  expect(await importLegacyManifest(root)).toMatchObject({ manifest: { revision: 10 } });
  const record = JSON.parse((await readFile(join(root, "research-events.jsonl"), "utf8")).trim());
  expect(await readFile(join(root, record.payload.snapshot), "utf8")).toBe(bytes);
  await rebuildResearchManifest(root); await appendResearchEvent(root, event("new"));
  expect(await importLegacyManifest(root)).toMatchObject({ event_count: 2 });
  expect((await rebuildResearchManifest(root)).manifest.candidates).toHaveProperty("old");
  expect(await readFile(join(root, record.payload.snapshot), "utf8")).toBe(bytes);
});
it("requires linked evidence for completion and freezes completed experiment decisions", () => {
  const prefix: any[] = [event("one")];
  const experiment = { candidate_id: "one", hypothesis: "test", protocol_version: 1, execution_ids: ["exec_eval"], result_path: "experiments/test/result.json", status: "completed", evaluation: { source: "parent_tool", execution_id: "exec_eval", result_artifact: { artifact_id: "result", version: 1 }, evaluator_digest: "a".repeat(64), data_digest: "b".repeat(64) } };
  const completed = { schema_version: 1, event_id: "evaluation", research_id: "study.v1", type: "experiment_recorded", payload: { experiment_id: "test", experiment } };
  expect(() => projectResearchEvents([...prefix, completed])).toThrow();
  prefix.push({ schema_version: 1, event_id: "link", research_id: "study.v1", type: "execution_linked", payload: { execution_id: "exec_eval", candidate_id: "one", artifact_refs: [{ artifact_id: "result", version: 1 }] } });
  expect(projectResearchEvents([...prefix, completed]).manifest.experiments.test.status).toBe("completed");
  const selected = { schema_version: 1, event_id: "selected", research_id: "study.v1", type: "candidate_selected", payload: { candidate_id: "one", experiment_id: "test", reason: "Verified independent evidence" } };
  expect(projectResearchEvents([...prefix, completed, selected]).decisions).toHaveLength(1);
  expect(() => projectResearchEvents([...prefix, selected])).toThrow("completed linked");
  expect(() => projectResearchEvents([...prefix, completed, { ...completed, event_id: "rewrite" }])).toThrow("cannot be rewritten");
  expect(() => projectResearchEvents([...prefix, { ...completed, payload: { experiment_id: "test", experiment: { ...experiment, self_reported_score: 0 } } }])).toThrow();
});
it("serializes separate append processes and releases its OS lock after a crashed writer", async () => {
  const root = await directory(); const script = new URL("../scripts/research-journal.mjs", import.meta.url).href;
  const run = (index: number) => new Promise<void>((resolve, reject) => {
    const code = `import {appendResearchEvent} from ${JSON.stringify(script)}; await appendResearchEvent(${JSON.stringify(root)},${JSON.stringify(event(`writer-${index}`))});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" }); child.once("error", reject); child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(`Writer ${status}`)));
  });
  await Promise.all([run(1), run(2), run(3)]);
  expect(await readResearchJournal(root)).toMatchObject({ event_count: 3 });
  await new Promise<void>((resolve, reject) => {
    const code = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(${JSON.stringify(join(root, "research-events.lock.sqlite"))}); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "ignore"] }); child.once("error", reject); child.stdout!.once("data", () => child.kill("SIGKILL")); child.once("exit", () => resolve());
  });
  await run(4); expect(await readResearchJournal(root)).toMatchObject({ event_count: 4 });
}, 15_000);
it("refuses linked journals instead of modifying their targets", async () => {
  const root = await directory(), outside = await directory();
  await writeFile(join(outside, "data"), "preserve"); await symlink(join(outside, "data"), join(root, "research-events.jsonl"));
  await expect(appendResearchEvent(root, event("one"))).rejects.toThrow("single-link");
  expect(await readFile(join(outside, "data"), "utf8")).toBe("preserve");
});

it("reconciles partially acknowledged batches and derives checkpoints without another ledger", async () => {
  const { appendResearchEvents } = await import("../scripts/research-journal.mjs");
  const root = await directory();
  const checkpoint = { schema_version: 1, event_id: "pause", research_id: "study.v1", type: "checkpoint_recorded", payload: { phase: "review", next_actions: ["Inspect evidence"], blockers: [] } };
  await appendResearchEvent(root, event("one"));
  const projection = await appendResearchEvents(root, [event("one"), event("two"), checkpoint]);
  expect(projection).toMatchObject({ event_count: 3, checkpoint: { phase: "review", next_actions: ["Inspect evidence"] } });
  expect(await appendResearchEvents(root, [event("one"), event("two"), checkpoint])).toEqual(projection);
  await expect(readFile(join(root, "state.json"))).rejects.toThrow();
  const bytes = await readFile(join(root, "research-events.jsonl"), "utf8");
  await expect(appendResearchEvents(root, [event("three"), { ...event("bad"), type: "unknown" }])).rejects.toThrow();
  expect(await readFile(join(root, "research-events.jsonl"), "utf8")).toBe(bytes);
});
