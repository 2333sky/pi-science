# Trusted evaluator foundation (Phase A)

This change follows PR #158 at `ace7c01c` (including the supplied design's `3be24809` baseline). It adds an offline registry and internal input-validation components. **There is still no production `evaluate_candidate` tool, approved execution capability, or authoritative score.** Auto Research continues to report `trusted evaluator unavailable` unless an operator supplies independent external evidence.

## Delivered boundary

The operator can register, verify and permanently revoke a revision using an offline CLI. The registry is an explicitly selected, pre-existing Linux directory, owned by the service operator with mode `0700`, outside all configured Agent-writable roots. Registry ancestors must not be writable by other users, except sticky shared ancestors. The operator must supply every untrusted workspace root and custom runtime read grant to the registry constructor; the CLI accepts one untrusted root (which can be the common workspace parent), and reads operator runtime paths from `PI_SCIENCE_SANDBOX_RUNTIME_PATHS`, `PI_SCIENCE_SANDBOX_PYTHON_ROOT` and `PI_SCIENCE_ENVIRONMENT_PREFIX`. Registry/source overlap with system runtime read trees and configured dependency roots is rejected: being outside a workspace alone would not keep files under `/usr/lib` private. There is no default workspace-local registry, registration HTTP endpoint, Worker import or model-selected elevated mode.

Registration validates strict metadata and copies evaluator, dataset and environment directories into private snapshots. Source directories must be outside the registry and all untrusted roots. Each tree is limited to 10,000 entries and 256 MiB; links and special files are rejected. Digests include relative file names, executable flags and SHA-256 of file bytes. Frozen files are owner-readable and optionally executable; directory access remains private to the operator. Any source change requires a new revision to affect registered bytes. Loading rehashes all three stored trees, checks revocation without an approval cache, and rejects drift. Existing IDs, partial registrations and revoked IDs cannot be overwritten or reactivated. An interrupted registration may leave an unavailable reserved ID or private staging directory; an operator can clean staging manually and register a new ID.

Linux reads walk parent directories through pinned `/proc/self/fd` descriptors with `O_NOFOLLOW`, open files without blocking on special files, require single-link regular files, bound bytes, and detect concurrent changes through descriptor metadata. The process must have `/proc/self/fd` available. Windows/macOS registry and evaluator reads fail closed. These are file-integrity controls, not a hostile multitenant isolation claim.

`EvaluatorInputService` requires two server-owned callbacks: authenticated caller context and verified candidate provenance. Neither is implemented by a default that trusts tool arguments or manifest producer strings. The gate rejects delegated children, mismatched Parent/workspace/research bindings and unknown request fields. Its request contract contains only evaluator revision ID, artifact ID and artifact version. The returned private preparation object is not a durable approval or launch token; a future runner must reauthorize and admit atomically immediately before execution.

Candidate resolution accepts only historical manifests and content-addressed snapshots in relocated state outside the workspace. The control plane must establish that state is inaccessible to Agents. Missing snapshots never fall back to mutable work files. Candidate digest, size, artifact ID/version, workspace, research and owning Parent must match independently verified provenance. Conflicting historical records fail closed; duplicate records with identical immutable fields are allowed because artifact verification appends metadata records. Public publication `producer` fields are ignored for authorization.

The initial supported submission is UTF-8 JSON `{ "predictions": [0, 1, 0.5] }` with no other properties. Registration fixes numeric bounds, item counts and maximum bytes. CSV, NPY and arbitrary submission schemas remain unsupported. Result validation permits only registered aggregate metric names, finite numbers within approved ranges and registered validity checks. Successful validity requires all declared checks; invalid validity suppresses scores. Precision and units are registered per metric. Validation errors expose safe codes, never supplied field names, private paths or output content.

## Operator CLI

Create the private root through normal operator provisioning; the CLI will not create or repair permissive state automatically. Use a frozen, dedicated, link-free environment bundle. This phase stores and verifies environment bytes; it does not yet select an executable or validate a usable Python runtime.

```sh
pnpm --filter @pi-science/server exec tsx src/cli/evaluator-registry.ts register /srv/pi-evaluators /srv/pi-workspaces /srv/approved/registration.json /srv/approved/evaluator /srv/approved/data /srv/approved/environment
pnpm --filter @pi-science/server exec tsx src/cli/evaluator-registry.ts verify /srv/pi-evaluators /srv/pi-workspaces eval-rev-001
pnpm --filter @pi-science/server exec tsx src/cli/evaluator-registry.ts revoke /srv/pi-evaluators /srv/pi-workspaces eval-rev-001
```

Example registration metadata (paths and identities are operator-selected, never tool arguments):

```json
{
  "id": "eval-rev-001",
  "researchId": "research-001",
  "ownerSessionId": "parent-session-001",
  "workspace": "/srv/pi-workspaces/project-001",
  "protocolRevision": "protocol-001",
  "environmentRevisionId": "python-001",
  "submission": { "format": "json", "minItems": 1, "maxItems": 1000, "minimum": 0, "maximum": 1 },
  "metrics": { "accuracy": { "minimum": 0, "maximum": 1, "unit": "ratio", "precision": 3 } },
  "validityChecks": ["schema_valid", "dataset_match"],
  "timeoutSeconds": 30,
  "maxSubmissionBytes": 1048576,
  "maxQueries": 10,
  "visibility": "validation",
  "acceptance": {
    "knownAnswer": "operator baseline fixture and expected score reference",
    "negativeCases": ["dataset mismatch fixture reference"],
    "boundaryCases": ["empty/minimum/maximum fixture references"]
  }
}
```

`acceptance` records operator-provided case references only. It is not proof those cases executed, and registration is not activation or sandbox acceptance. The CLI always reports `scoring_available: false`. Revocation is irreversible for an ID. The registry trusts the operator and filesystem access controls; it does not defend against a malicious administrator rewriting both assets and metadata.

## Remaining delivery gates

- Complete the authenticated Worker/session ancestry and research-budget adapter, and derive candidate provenance from private execution/publication evidence. Caller-supplied `session_id`, role strings, workspace manifests and model-generated hashes cannot establish these facts.
- Add a service-only evaluator policy and fixed Linux required-mode runner using the pinned srt launcher. Select and verify interpreter/dependencies, privately stage exact captured bytes, and enforce no network, secrets, general workspace mounts or protected-input writes.
- Admit execution and per-research/per-revision queries durably and atomically; enforce final-holdout authorization, revocation at admission, deadlines, bounded output, cancellation, owner death, process-group teardown and crash/replay rules. The stored `maxQueries`, timeout and visibility fields do not enforce execution limits in Phase A because no execution exists.
- Persist truthful Execution and safe metric Artifact evidence, including protocol/evaluator/data/environment revisions and input digest. Do not publish prepared private objects or raw evaluator output.
- Run known-answer, negative/boundary and real Linux isolation acceptance before activating any revision or registering the Parent-only tool. Update Auto Research contracts only after the full baseline → candidate → evaluator → reviewer → report flow passes.

Normal Bash/Notebook policy, `research/` denial and existing Auto Research completion semantics remain unchanged.

## Validation

```sh
pnpm --filter @pi-science/server exec vitest run src/runtime/evaluation/evaluator.test.ts
pnpm --filter @pi-science/server typecheck
```

The foundation suite covers frozen sources, immutable revision IDs/concurrent registration, revocation, code/data/environment drift, private roots, workspace/source overlap, links, size limits, strict requests, Parent scope checks, historical content, provenance mismatch, live-file fallback rejection, unsafe predictions and aggregate-result filtering. These tests do not assert real sandbox execution or production authentication.
