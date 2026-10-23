# Skill resource policy scan benchmark

Run from the repository root:

```sh
pnpm --filter @pi-science/server exec tsx scripts/benchmark-skill-resources.ts
```

The script creates four enabled directory Skills with 0, 1,000, 5,000 and 20,000 ordinary helper files in total. It measures workspace admission separately from full per-Bash workspace plus Skill admission. Fixture creation and one warmup per operation are excluded; five timed samples produce raw milliseconds and nearest-rank p50/p95 in JSON. With five observations, p95 is the maximum, not a production percentile estimate. The temporary fixture is deleted even on failure.

The benchmark checks read-only grants and creates a new credential file after the initial scan, verifying that a later admission still denies it. There is no cross-invocation scan cache. Shared runner load, OS, filesystem and hardware affect results. Linux and macOS acceptance CI run this benchmark and upload the JSON alongside isolation test results. CI records timings without a fixed cross-platform wall-clock ceiling; stable dedicated runners can opt into a p95 ceiling using `SKILL_BENCH_MAX_P95_MS`. Correctness assertions always fail the run if fresh sensitive files are exposed or resource grants lose their read-only scope.

Configuration: `SKILL_BENCH_FILES` accepts up to four sizes from 0–30,000; `SKILL_BENCH_SKILLS` accepts 1–32; `SKILL_BENCH_SAMPLES` accepts 3–10; `SKILL_BENCH_MAX_P95_MS` accepts a positive ceiling up to 60,000 ms. For comparable results, retain the same fixture sizes, sample count and machine.

Large trees impose a real per-invocation cost: an initial Linux/Node v24.19.0 run measured full-admission p50/p95 of 273/314 ms for 1,000 files, 910/1,011 ms for 5,000, and 4,348/8,806 ms for 20,000. A concurrent server build increased the 20,000-file p95 to 19,570 ms in another run, illustrating the sensitivity to load. These are local observations, not cross-platform guarantees. This change records the cost; reducing scans must continue to detect newly created sensitive files, links and revocations.
