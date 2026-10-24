# Skill resource policy scan benchmark

Run from the repository root:

```sh
pnpm --filter @pi-science/server exec tsx scripts/benchmark-skill-resources.ts
```

The script creates four enabled directory Skills with 0, 1,000, 5,000 and 20,000 ordinary helper files in total. It measures workspace admission separately from full per-Bash workspace plus Skill admission. Fixture creation and one warmup per operation are excluded; five timed samples produce raw milliseconds and nearest-rank p50/p95 in JSON. With five observations, p95 is the maximum, not a production percentile estimate. The temporary fixture is deleted even on failure.

The benchmark checks read-only grants and creates a new credential file, symlink and external hardlink after the initial scan, verifying that a later admission still denies them. An additional helper is used for the hardlink check, independent of the configured file count. There is no cross-invocation scan cache. Shared runner load, OS, filesystem and hardware affect results. Linux and macOS acceptance CI run this benchmark and upload the JSON alongside isolation test results. CI records timings without a fixed cross-platform wall-clock ceiling; stable dedicated runners can opt into a p95 ceiling using `SKILL_BENCH_MAX_P95_MS`. Correctness assertions always fail the run if fresh sensitive files are exposed or resource grants lose their read-only scope.

Configuration: `SKILL_BENCH_FILES` accepts up to four sizes from 0–30,000; `SKILL_BENCH_SKILLS` accepts 1–32; `SKILL_BENCH_SAMPLES` accepts 3–10; `SKILL_BENCH_MAX_P95_MS` accepts a positive ceiling up to 60,000 ms. For comparable results, retain the same fixture sizes, sample count and machine.

Large trees impose a real per-invocation cost: an initial Linux/Node v24.19.0 run measured full-admission p50/p95 of 273/314 ms for 1,000 files, 910/1,011 ms for 5,000, and 4,348/8,806 ms for 20,000. A concurrent server build increased the 20,000-file p95 to 19,570 ms in another run, illustrating the sensitivity to load. These are local observations, not cross-platform guarantees. This change records the cost; reducing scans must continue to detect newly created sensitive files, links and revocations.

## Bounded metadata concurrency

Protected-path discovery checks metadata in batches of at most 32 entries per scan, visiting child directories after their batch completes. It still inspects fresh metadata for every ordinary entry on every invocation: directory-mtime caching cannot detect a new hardlink made outside the scanned tree. Sensitive directories are skipped, inspection failures reject admission, the 100,000-entry safety cap is unchanged, and the final deny list remains sorted. The same scanner serves workspace, configured filesystem grants, confined execution and Skill resources. Artifact snapshot behavior is unchanged.

A local comparison on macOS arm64, Node v24.18.0, four Skills and three timed samples per size used the original fixture and benchmark for both implementations (before the additional link assertions above). Fixture generation and one warmup were excluded. These results measure full Bash workspace-plus-Skill admission, not total Bash latency. With three observations, p95 is the maximum sample.

| Helper files | Serial p50 / p95 (ms) | Batched p50 / p95 (ms) | p50 reduction |
| --- | --- | --- | --- |
| 1,000 | 31.19 / 33.31 | 12.81 / 19.51 | 59% |
| 5,000 | 111.63 / 123.77 | 49.14 / 49.21 | 56% |
| 20,000 | 466.97 / 561.10 | 184.75 / 189.25 | 60% |

This reduces serialized filesystem waits without introducing a stale-authorization window. Work remains proportional to the permitted tree size; no cross-platform latency guarantee is implied.
