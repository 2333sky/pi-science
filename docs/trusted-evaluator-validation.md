# Trusted evaluator validation

The current production feature and setup are documented in [Trusted evaluator](trusted-evaluator.md). The Phase A and review sections below preserve earlier verification history; they do not describe the final delivered scope.

## Production continuation (Phases B–D)

On 2026-10-16 the real official DeepSeek provider test for `deepseek-flash` passed through authenticated Parent → Experimenter → evaluate_candidate → Reviewer → report. It used the production Worker/provider/IPC path and an operator-approved frozen evaluator in required-mode Linux srt. The test asserted one official evaluation, accuracy=1, validity passed, actual exit code 0 and a published versioned metric Artifact. The Agent obtained the candidate Artifact reference from actual Bash/child tool output. No harness-side score calculation or private-reference substitution drove the request. The selected live test passed in 65.20 seconds total (64.03 seconds test time); nine unrelated cases were unselected at that checkpoint. The supplied key remained in process input/memory/environment, stored credentials referenced its environment variable, and temporary private test state was removed. The sanitized log is under ignored `.runtime/live-tests/deepseek-evaluator-live.log`; no key is committed.

The independent deterministic model fixture additionally verifies transport/security behavior, restart reuse and owner exit. Real Linux tests cover unapproved/revoked revision rejection, baseline/negative/boundary approval, readonly frozen inputs, blocked original workspace/data/network, valid metrics, malformed/nonzero/linked outputs, timeout/Abort, excessive logs, false validity, concurrent idempotence, changed-input rejection, uncertain completion marked lost, durable query caps and explicit final-holdout authorization. Unit tests cover shared atomic research/revision/generic reservations and file-tool protection of private state/links. Model fixtures do not establish scientific reasoning quality; the live test establishes this prescribed known-answer workflow, not universal research quality.

Final real Linux combined acceptance: **65 passed / 2 skipped** across Candidate tools, Agent IPC, universal sandbox and evaluator acceptance (99.87 seconds). The two skips are the opt-in paid provider test and the unsupported-platform case. Workspace typecheck passed. Focused evaluator/Worker compatibility checks passed all 88 tests before the final combined run.

Final full workspace regression passed: contracts **14**, server **1,019** (52 configured skips), frontend **1,778**, and Skills **37**; **2,848 passed** in total. The server suite completed in 247.75 seconds and frontend in 256.60 seconds. `pnpm typecheck` and `pnpm build` passed; Vite emitted its existing chunk-size advisory. Whitespace and staged credential-pattern checks passed.

The preceding commit's Windows quality run exposed a cold-start cancellation test that assumed concurrent filesystem preparation preserves launch order (`expected [] to include SIGTERM`). The test now waits for the target's first pending request before launching the survivor; both starts remain unresolved during shutdown, preserving the cancellation/isolation assertion without depending on spawn order. Production kernel cancellation logic is unchanged. Native Windows validation remains delegated to CI.

Initial production contract: bounded JSON predictions only, Linux required mode, operator-frozen Python environment plus minimum trusted OS runtime. CSV/NPY, arbitrary Candidate code, optional task-specific cohort suppression, native unsupported platforms and hard CPU/memory/disk/GPU quotas remain outside this contract.

## Historical Phase A verification

Implementation branch: `feat/trusted-evaluator`.
Base: PR #158, `ace7c01c` (supplied design baseline `3be24809` is an ancestor).

Delivered scope and remaining execution gates are documented in [Phase A](trusted-evaluator-phase-a.md). Registration remains offline and `scoring_available` is always false. No production Worker/tool or normal sandbox policy changed.

Verified on Linux with Node `v24.19.0`, 2026-10-16:

| Check | Result |
| --- | --- |
| `pnpm --filter @pi-science/server exec vitest run src/runtime/evaluation/evaluator.test.ts` | 69 passed, including CLI lifecycle and runtime read-grant overlap rejection |
| `pnpm typecheck` | contracts, server and frontend passed |
| `pnpm --filter @pi-science/server test` | 112 files passed, 2 skipped; 998 tests passed, 39 skipped; 247.81 seconds |
| `pnpm --filter @pi-science/server typecheck` after the final registry changes | Passed |
| `pnpm build` after the final registry changes | contracts, server and frontend passed |
| Whitespace checks on tracked changes and all new source/docs | No whitespace errors |

The complete server suite ran during integration. The final runtime read-grant restriction and error-redaction assertions were subsequently verified by the focused 69-test suite, server typecheck and full build. Vite reported a chunk-size advisory; the build completed successfully. No frontend source or dependency versions changed.

These checks do not establish production authentication, real evaluator isolation, budget/replay safety, or scientific correctness; those remain future acceptance gates. Windows/macOS behavior was not exercised on native hosts. This work is submitted separately on `feat/trusted-evaluator`, targeting PR #158's `feat/universal-sandbox` branch without modifying that branch.

## Requested real DeepSeek API verification

On 2026-10-16, the user explicitly authorized real API testing with the official DeepSeek endpoint and `deepseek-flash`. The supplied key was passed through terminal input with echo disabled and then through process memory/environment only; it was not written into source, test settings or this report. Output capture redacted the key. Temporary provider settings stored an environment-variable credential reference and were removed with the live-test workspace.

| Check | Observed result |
| --- | --- |
| Official `POST https://api.deepseek.com/v1/chat/completions` | HTTP 200, returned model `deepseek-flash`, exact expected reply `LIVE_API_OK`; 10 prompt + 4 completion tokens; 2.16 seconds |
| Required-mode Bash preflight in `universal-sandbox.test.ts` | 1 passed, 10 unselected tests skipped |
| `PI_SCIENCE_DEEPSEEK_LIVE_TEST=1 … vitest run src/runtime/agent/deepseek-sandbox.live.test.ts` | 1 passed, no skipped tests; 13.83 seconds test time, 14.79 seconds total |

The live test exercises the product's managed OpenAI-compatible provider route, real Agent Workers and real srt/Bubblewrap isolation. Its assertions verify both main and delegated-child Bash outputs, two successful Bash Execution records in required mode, sandbox policy IDs, published artifacts, absence of `DEEPSEEK_API_KEY` in the tool environment and denied access to protected workspace state.

The first live attempt found `model not found` during Worker initialization: the test created an environment-backed credential but omitted the explicit Worker environment that production session initialization supplies. The test now passes only `DEEPSEEK_API_KEY` through the existing allowed Worker environment interface. Parent-to-child credential routing remains server-controlled, and tool environment filtering is unchanged. After this test-only fix, the real API test passed.

The executor had Bubblewrap and ripgrep but lacked socat. A Debian socat package was extracted into ignored `.runtime/sandbox-deps`; no system package or dependency manifest changed. The test selected the explicit socat/ripgrep paths and retained required isolation. Sanitized HTTP metadata and the live-test log are stored under ignored `.runtime/live-tests`.

This verifies the existing real provider/main/child sandbox flow. The Phase A evaluator registry still has no production `evaluate_candidate` tool or runner, so the live API result does not establish authoritative evaluator scoring or the future evaluator's isolation/admission guarantees.

## Review follow-up

The two P2 review follow-ups are implemented in the same PR:

- Resource handling: registration streams directly into private snapshots, while load performs streaming rehashes without retaining file bodies. All three trees share one 256 MiB / 10,000-entry budget and one reusable 64 KiB buffer. Registry-wide cross-process locking serializes register/load/revoke work. The original v1 digest encoding is retained. A 96 MiB registration and repeated verification remain below 16 MiB additional sampled array-buffer memory; a final-byte edit is still detected. Three individually valid 96 MiB trees are rejected by the aggregate cap.
- Read-grant authority: registry and srt settings now consume `PI_SCIENCE_SANDBOX_READ_POLICY`, a private operator file with explicit dependency/protected roots. Registry use requires this policy; the independent optional dependency-list constructor argument and CLI environment parsing are removed. Settings reject undeclared runtime dependencies and protected-root read/write conflicts, and the configured protection roots enter ordinary sandbox denies. Worker configuration cannot replace the server-selected policy path. Effective policy changes alter persistent-kernel identity, and startup checks the admitted policy digest. HTTP authorization binds that digest before recording Execution evidence; the real kernel test checks the recorded policy ID against the running kernel.

Operators must stop active workloads before changing policy roots; an already running OS sandbox is not retroactively remounted. The next Notebook cell uses the current policy and retires a stale namespace. This remains Phase A and does not activate official evaluator execution.

Focused verification after the fixes: 112 passed / 1 skipped across evaluator, shared-policy, Worker environment and kernel regressions. Real Linux sandbox/Agent IPC/compatibility acceptance: 55 passed / 1 skipped across `sandbox-tool.test.ts`, `agent-core-tools.test.ts` and `universal-sandbox.test.ts`. The four selected real Bash/kernel policy and lifecycle checks also passed independently. Sandbox acceptance CI now includes the universal suite and triggers on sandbox/kernel/evaluation changes. The earlier DeepSeek API evidence remains historical evidence for the original smoke test; no new provider call was needed for these review fixes.

Full server integration regression after the review changes: **1,015 passed / 41 skipped** across 115 files (113 passed, 2 skipped), 242.22 seconds. The final HTTP admission/evidence binding was subsequently covered by the 112-test focused suite and repeated real Linux acceptance (55 passed / 1 skipped, 61.90 seconds), including exact Execution/kernel policy-ID agreement. Workspace typecheck and build were rerun after those final source changes.
