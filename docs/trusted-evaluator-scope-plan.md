# Server-controlled evaluator scope and delivery gates

The production implementation now covers the original Phase A–D path: offline frozen registration and sandbox-tested approval, authenticated Parent-only IPC, dedicated Linux execution, durable admission/recovery, safe evidence and Auto Research integration. See [setup and supported contract](trusted-evaluator.md) and [observed verification](trusted-evaluator-validation.md). The initial allowlist is bounded JSON predictions; CSV/NPY, arbitrary Candidate programs and optional task-specific cohort rules are not part of that contract.

PR #158 remains the unchanged sandbox base. Ordinary Parent Bash/Notebook still cannot read held-out research data. Official scoring uses the separate server-owned evaluator scope; candidate process success or Reviewer PASS is insufficient.
## Authorization and registration

Add an operator-controlled evaluator registry outside writable workspaces. An authenticated operator registers a versioned evaluation protocol, canonical evaluator entry point, interpreter/environment revision, immutable evaluator/input digests, output schema, timeout and permitted research scope. Registration/updates require explicit operator authorization. Agent-authored `evaluation.yaml`, tool parameters, task text, model-written hashes and internal Worker identity alone cannot register or approve executable evaluators. Changed executable/input/environment digests require a newly authorized revision, preserving old approvals and results.

The control plane owns an `evaluateCandidate` operation taking only a registered evaluator revision and candidate artifact version, never command text, code, runtime paths or a policy object. The server authenticates the owning Parent session and research budget; all delegated children (including Experimenter and Reviewer) and unrelated Parents are rejected. Unknown, revoked, stale or changed registrations fail closed. Existing Bash/Notebook schemas gain no elevated policy switch.

## Execution and evidence

Resolve predictions from immutable artifact bytes using stable no-follow descriptor reads and size/type limits. Never execute Candidate code or import its work directory. Reverify registered evaluator/input bytes and environment revision before launch. Stage those exact bytes privately and use the existing pinned srt launcher and cleanup lifecycle. A server-created evaluator policy grants only registered read-only evaluator/frozen inputs, staged prediction artifact, a dedicated writable result directory and trusted runtime dependencies. Deny network, credentials, evaluator/input writes, sibling candidates and general workspace access. Preserve the ordinary `research/` deny rule.

Charge the existing research budget before launch; bound timeout/output and use existing Execution/Artifact stores. Record actual exit/error status, policy ID, evaluator/protocol/environment revisions, input and prediction digests, and validated metrics/validity failures. Failed or interrupted evaluations produce no official score. Publish only bounded registered outputs, never raw held-out inputs or arbitrary filesystem content. Resume reads completed immutable evidence rather than silently reexecuting or accepting stale revisions.

## Acceptance required before enabling

- Real Parent → registered evaluator → authoritative result flow with a known-answer baseline and repaired Candidate in required mode.
- Reject delegated/unrelated identities, forged policy/registration fields, exhausted budgets and revoked/changed evaluator/input/environment revisions.
- Reject prediction/evaluator symlink and hardlink swaps and concurrent replacement; prove scores use the recorded immutable bytes.
- Prove Candidate/main Bash/Notebook cannot access frozen inputs, and evaluator processes cannot access credentials, network, sibling candidates or write evaluator/input files.
- Verify nonzero exit, malformed results, timeout, Abort, Worker exit and replay produce truthful evidence and no false score; cover policy transitions and cleanup.

When setup or authorization is absent, report `trusted evaluator unavailable` before spending Candidate execution budget on workflows requiring independent scoring. An operator may evaluate externally and supply provenance, but this is a manual dependency, not autonomous product evaluation. Do not switch to `trusted-host` or move held-out inputs into ordinary workspace access to bypass the protected scope.
