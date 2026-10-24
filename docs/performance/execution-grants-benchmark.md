# Confined authorization benchmark

Run from the repository root:

```sh
pnpm --filter @pi-science/server exec tsx scripts/benchmark-execution-grants.ts
```

The script creates and removes a private temporary workspace and service state. It measures a full grant authorization and a delegated small-file read, including the Worker capability guard, both confined-read authorization phases, locking and actual file capture. It creates 0, 5,000 or 20,000 unrelated scientific files in sibling directories; the grant itself contains one small input file. Setup and one warmup per operation are excluded; each result uses five samples. The default takes seconds, creates no network processes and invokes no model. `GRANT_BENCH_FILES` accepts at most four sizes from 0 to 30,000, and `GRANT_BENCH_SAMPLES` accepts 3–10.

Measured on 2026-10-19 in the same Linux container with Node v24.19.0. Baseline is `1b9b051c`; raw local results are in [execution-grants-benchmark.json](execution-grants-benchmark.json). These small warm-cache samples establish scaling for this fixture; p95 is the maximum of five observations, not a production percentile guarantee. Hardware, OS/filesystem, grant-tree size and concurrent load affect timings.

| Unrelated files | Operation | Before p50 / p95 (ms) | After p50 / p95 (ms) |
| ---: | --- | ---: | ---: |
| 0 | authorization | 4.80 / 8.08 | 3.25 / 7.04 |
| 0 | delegated_read | 9.53 / 12.50 | 10.60 / 14.24 |
| 5,000 | authorization | 87.66 / 109.90 | 2.10 / 2.80 |
| 5,000 | delegated_read | 317.11 / 353.40 | 7.11 / 9.01 |
| 20,000 | authorization | 350.46 / 390.46 | 1.40 / 2.78 |
| 20,000 | delegated_read | 1136.85 / 1166.48 | 4.68 / 6.60 |

Every authorization previously traversed the entire workspace and the granted trees. Confined execution can only access its selected roots; current authorization therefore scans those trees and checks sensitive ancestors up to the workspace, excluding inaccessible siblings. Full parent/workspace admission remains unchanged. Root scans retain their 4,096-entry bound, so large **granted** trees still cost time and can fail closed at that limit. No wall-clock threshold is imposed in CI; a structural regression checks the actual scan roots.

Nothing is cached across calls: private grant/config hashes, ancestor revocation, Worker/budget binding, tool ceilings, budget cancellation/deadlines, directory identities and live operator-protected roots are rechecked. New protected descendants are discovered each time. The read lock uses its newly validated policy for capture, including when a sensitive file appears between authorization phases. Existing live grant/budget watchdog tests remain required.

This optimization does not establish native Windows/macOS latency or completed cross-platform CI acceptance.
