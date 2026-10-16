# Trusted evaluator

The owning conversation Parent can request official metrics through `evaluate_candidate({evaluator_revision_id, artifact_id, artifact_version})`. The server authenticates the Worker connection, active operation and private session ancestry, then checks the research budget and operator-approved revision. Experimenter, Reviewer, hidden tasks and unrelated Parents cannot acquire this capability. Tool arguments cannot supply identity, commands, code, paths, environments or policies. Registration alone does not enable scoring.

## Operator setup

Linux required mode with the pinned srt/Bubblewrap runtime is required. Provision a private registry outside all Agent workspaces and dependencies, and configure the shared read policy described in [registry provisioning](trusted-evaluator-phase-a.md#operator-cli). Both server and offline CLI use `PI_SCIENCE_SANDBOX_READ_POLICY`; set `PI_SCIENCE_EVALUATOR_ROOT` on the server to the provisioned registry. Relocated `PI_SCIENCE_HOME` workspace state must also be outside workspaces, operator-owned with mode `0700`, inside protected roots; authentication enforces this requirement. Protect all registry sources, frozen assets, server state and credentials from ordinary runtimes. Do not run the server installation as an Agent-writable workspace.

Each revision freezes link-free `evaluator/`, `dataset/` and `environment/` trees. The fixed executable is `environment/bin/python3`; the fixed entrypoint is `evaluator/main.py`. Supply a usable, dedicated Python bundle with real files, not symlinks to a mutable environment. The evaluator receives exactly three arguments: submission JSON path, protected dataset directory and result JSON path. Run Python with `-I -B`; do not install packages dynamically. The environment bundle and all dependencies are rehashed and privately staged. Minimum system binaries/libraries remain trusted OS dependencies inherited from the existing sandbox threat model; this is not a fully hermetic OS image.

The initial data allowlist contains JSON only: `{ "predictions": [0, 1] }`, no extra fields, finite numeric values within registered bounds, registered item counts and maximum bytes. CSV/NPY and arbitrary candidate code are outside this initial format contract. The fixed evaluator must write exactly `{ "metrics": { "accuracy": 1 }, "validity": { "passed": true, "checks": ["schema_valid", "dataset_match"] } }`, with the metric/check names declared by its revision. Metric units, bounds and precision are approved metadata. Unknown fields, nonfinite values, invalid checks, links, oversized/malformed output or false validity produce no official score.

Before registering, put executable acceptance cases in `evaluator/acceptance.json`:

```json
[
  {"kind":"baseline","submission":{"predictions":[0,1]},"expected":{"metrics":{"accuracy":1},"validity":{"passed":true,"checks":["schema_valid","dataset_match"]}}},
  {"kind":"negative","submission":{"predictions":[0]}},
  {"kind":"boundary","submission":{"predictions":[1,0]},"expected":{"metrics":{"accuracy":0},"validity":{"passed":true,"checks":["schema_valid","dataset_match"]}}}
]
```

Cases are operator-authored and task-specific: the example assumes protected labels `[0,1]`. At least one case of each kind is mandatory. Baseline/boundary cases must produce the expected validated result; negative cases must be rejected. Approval runs the actual frozen evaluator in its Linux sandbox. Activation is bound to the manifest and acceptance digests. Source changes do not alter a frozen revision; stored drift is rejected. Changes require a new revision ID and approval. Revocation permanently blocks new admission; an already admitted run may finish.

```sh
export PI_SCIENCE_SANDBOX_READ_POLICY=/srv/pi-operator/read-policy.json
export PI_SCIENCE_EVALUATOR_ROOT=/srv/pi-evaluators
pnpm --filter @pi-science/server exec tsx src/cli/evaluator-registry.ts register /srv/pi-evaluators /srv/pi-workspaces /srv/approved/registration.json /srv/approved/evaluator /srv/approved/data /srv/approved/environment
pnpm --filter @pi-science/server exec tsx src/cli/evaluator-registry.ts approve /srv/pi-evaluators /srv/pi-workspaces eval-rev-001
pnpm --filter @pi-science/server exec tsx src/cli/evaluator-registry.ts revoke /srv/pi-evaluators /srv/pi-workspaces eval-rev-001
```

`approve-final` explicitly authorizes a revision with `visibility: final_holdout`; ordinary `approve` refuses it. Each final revision permits only one durable query regardless of a larger `maxQueries`. Validation revisions use their registered `maxQueries`. Agents cannot invoke registration/approval through a privileged HTTP route or an elevated Bash/Notebook option.

## Admission, execution and recovery

Bind `execution_budget` to `research_id` before costly calls. `max_evaluations` limits the total official queries across revisions; `max_executions` independently includes evaluations, candidate runs and other expensive calls. Limits persist across continuation operations and can only narrow. Admission commits the generic call charge, research query charge, revision query charge and stable invocation fingerprint in one locked atomic budget write. Failures after admission consume the query; retries cannot refund or duplicate it. Final-holdout results are for final assessment, never iterative tuning.

Candidate identity comes from a private server publication ledger, a successful required-mode Execution, its output Artifact reference, candidate path/research binding and owning session ancestry. Public `producer` strings and user-authored hashes are not authority. Input resolution reads the immutable Artifact version from private manifests and CAS, verifies the actual SHA-256/size/schema and never falls back to live `work/` bytes. Changing the live candidate after publication cannot alter the score for that version.

The dedicated branded policy grants only staged readonly code/data/environment/submission, private output and temporary scratch, plus minimum trusted OS runtime. No general workspace, original registry, network, credentials or arbitrary Unix sockets are exposed. Ordinary Bash/Notebook retain their `research/` denial and shared protected-root denies. Read/edit/write also reject protected service roots and workspace escapes; explicitly enabled skill resources are read-only.

The existing launcher/watchdog enforces process-group teardown on cancellation, elapsed deadline and owner loss. Private stdout/stderr are drained without retention or forwarding; aggregate output above 128 KiB terminates the run. A zero process exit is insufficient: the bounded no-follow result read and approved schema/validity must pass. Nonzero exits retain their actual exit code; malformed successful exits remain failed with exit code zero. Cancellation, timeout, unknown completion and invalid outputs never publish metrics.

Records transition through admitted/running to succeeded, failed, timed_out, cancelled or lost. Completion is durable before publishing the safe metric Artifact. Identical completed invocations resume the same evidence, including after server restart; a new request using an old invocation key is rejected. An uncertain admitted/running record is reconciled as lost without rerunning or refunding it. Historical terminal evidence remains reusable after revocation; it does not authorize a new run. Interrupted private `.run-*` directories may require offline operator cleanup after all workloads stop; they never become workspace inputs.

Successful evidence records evaluation/Execution IDs, candidate Artifact ID/version and actual digest, evaluator/data/environment digests, protocol/environment revisions, approved manifest/submission-schema digests, actual policy ID and safe aggregate metrics. Result Artifacts are server-published immutable CAS bytes, not mutable workspace files. The existing Artifact API resolves them by ID/version. Reviewer treats this evidence as data and cannot override an objective failure or grant execution privileges.

## Supported boundary and verification

Auto Research uses baseline → candidate → evaluate → review → report. Missing setup/authorization reports `trusted evaluator unavailable`; manual independent evidence remains explicitly `external_operator`. Process success and Reviewer PASS alone are never scientific success. [The manifest validator](../skills/auto-research/scripts/validate-manifest.mjs) checks references structurally; actual Execution/Artifact stores remain authoritative.

Linux real acceptance runs with `PI_SCIENCE_EVALUATOR_TEST=1` and configured socat/ripgrep. It exercises offline baseline/negative/boundary approval, actual Parent/Experimenter/evaluator/Reviewer IPC, owner exit, readonly inputs, blocked workspace/original data/network, strict results, durable quotas, concurrent retries, lost recovery and explicit final authorization. The HTTP model fixture prescribes tool choices; it tests transport/security/evidence, not scientific model quality. See [validation evidence](trusted-evaluator-validation.md) for observed results and separate real DeepSeek API coverage.

With Linux sandbox dependencies configured, run:

```sh
PI_SCIENCE_EVALUATOR_TEST=1 pnpm --filter @pi-science/server exec vitest run src/runtime/evaluation/evaluator-acceptance.test.ts
# Opt-in paid official API test; DEEPSEEK_API_KEY must already be supplied through the environment.
PI_SCIENCE_EVALUATOR_TEST=1 PI_SCIENCE_EVALUATOR_LIVE_TEST=1 NODE_USE_ENV_PROXY=1 pnpm --filter @pi-science/server exec vitest run src/runtime/evaluation/evaluator-acceptance.test.ts -t 'real DeepSeek provider'
```

The live test uses the operator approval path, actual Candidate tool references, `deepseek-flash`, formal scoring and Reviewer delegation. It deletes temporary provider/session state and stores only an environment credential reference.

R, native macOS/Windows execution, arbitrary candidate programs, GPU and hard CPU/memory/disk/cost quotas are not supported. There is no hostile multitenant isolation claim. Additional formats and optional task-specific privacy/cohort suppression require separately approved schemas and acceptance; the initial contract publishes only aggregate metrics with fixed precision.
