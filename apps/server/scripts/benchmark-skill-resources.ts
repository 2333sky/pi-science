/** Reproducible per-Bash policy benchmark; no workload or model calls. */
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { workspacePolicy } from "../src/runtime/sandbox/policy.js";
import { skillResourcePolicy } from "../src/runtime/sandbox/skill-resources.js";

const samples = Number(process.env.SKILL_BENCH_SAMPLES ?? 5);
const skillCount = Number(process.env.SKILL_BENCH_SKILLS ?? 4);
const sizes = (process.env.SKILL_BENCH_FILES ?? "0,1000,5000,20000").split(",").map(Number);
const maxP95Ms = process.env.SKILL_BENCH_MAX_P95_MS === undefined ? null : Number(process.env.SKILL_BENCH_MAX_P95_MS);
if (!Number.isInteger(samples) || samples < 3 || samples > 10 || !Number.isInteger(skillCount) || skillCount < 1 || skillCount > 32
  || sizes.length > 4 || sizes.some((size) => !Number.isInteger(size) || size < 0 || size > 30000)
  || (maxP95Ms !== null && (!Number.isFinite(maxP95Ms) || maxP95Ms <= 0 || maxP95Ms > 60000))) throw new Error("Benchmark bounds: 3–10 samples, 1–32 skills, up to four sizes of 0–30000 files, 0–60000ms budget");
const keys = ["PI_SCIENCE_HOME", "PI_SCIENCE_EXECUTION_MODE", "PI_SCIENCE_SANDBOX_PROFILES", "PI_SCIENCE_SANDBOX_READ_POLICY"] as const;
const previous = keys.map((key) => [key, process.env[key]] as const);
const scratch = await realpath(await mkdtemp(join(tmpdir(), "skill-resource-benchmark-")));
const rows: Array<{ skillFiles: number; skillCount: number; operation: string; samples_ms: number[]; p50_ms: number; p95_ms: number }> = [];
try {
  process.env.PI_SCIENCE_EXECUTION_MODE = "required";
  process.env.PI_SCIENCE_HOME = join(scratch, "service");
  process.env.PI_SCIENCE_SANDBOX_PROFILES = "";
  delete process.env.PI_SCIENCE_SANDBOX_READ_POLICY;
  for (const skillFiles of sizes) {
    const cwd = join(scratch, `workspace-${skillFiles}`);
    const roots = Array.from({ length: skillCount }, (_, index) => join(cwd, ".pi", "skills", `skill-${index}`));
    for (const root of roots) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "SKILL.md"), "---\nname: benchmark\ndescription: Benchmark resource fixture\n---\nRun helper.py");
    }
    for (let offset = 0; offset < skillFiles; offset += 100) {
      await Promise.all(Array.from({ length: Math.min(100, skillFiles - offset) }, async (_, index) => {
        const number = offset + index;
        const directory = join(roots[number % skillCount]!, `part-${Math.floor(number / (skillCount * 100))}`);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `helper-${number}.py`), "print('resource')\n");
      }));
    }
    const helper = join(roots[0]!, "fresh-link-check.py");
    await writeFile(helper, "print('resource')\n");
    const admission = async () => skillResourcePolicy(await workspacePolicy(cwd), roots);
    await admission();
    // Fresh sensitive files must remain visible to the scan; caching the first
    // tree would produce misleading performance and weaken authorization.
    const credential = join(roots[0]!, "credentials.json"); await writeFile(credential, "synthetic-secret");
    await link(helper, join(scratch, `outside-link-${skillFiles}.py`));
    const alias = join(roots[0]!, "fresh-symlink.py"); await symlink(helper, alias);
    const checked = await admission();
    assert.ok(checked.denyPaths.includes(credential));
    assert.ok(checked.denyPaths.includes(helper));
    assert.ok(checked.denyPaths.includes(alias));
    assert.ok(roots.every((root) => checked.readPaths.includes(root)));
    assert.ok(roots.every((root) => checked.writeDenyPaths?.includes(root)));
    for (const [operation, run] of [["workspace_policy", () => workspacePolicy(cwd)], ["bash_skill_policy", admission]] as const) {
      await run();
      const times: number[] = [];
      for (let index = 0; index < samples; index++) { const start = performance.now(); await run(); times.push(performance.now() - start); }
      times.sort((left, right) => left - right);
      rows.push({ skillFiles, skillCount, operation, samples_ms: times.map((time) => Number(time.toFixed(2))),
        p50_ms: Number(times[Math.ceil(samples * 0.5) - 1]!.toFixed(2)), p95_ms: Number(times[Math.ceil(samples * 0.95) - 1]!.toFixed(2)) });
    }
  }
  const failures = rows.filter((row) => maxP95Ms !== null && row.p95_ms > maxP95Ms);
  process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, warmup: 1, samples, maxP95Ms, passed: failures.length === 0, rows }, null, 2) + "\n");
  if (failures.length) throw new Error(`Skill policy p95 exceeded ${maxP95Ms}ms: ${failures.map((row) => `${row.operation}/${row.skillFiles}`).join(", ")}`);
} finally {
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(scratch, { recursive: true, force: true });
}
