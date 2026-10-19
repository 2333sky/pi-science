# Conversation-native Auto Research

Auto Research runs inside the current conversation Agent through skills/auto-research. There is no second Research API, scheduler or fixed role pipeline. Conversation abort stops active work; continuation reads durable evidence and the semantic checkpoint. Historical research archives remain read-only and are continued as a new conversation scope.

## Current runtime contract

Source-only tasks load only [literature research](../skills/auto-research/references/literature-research.md). They need read/write and authorized retrieval only when searching; execution_budget, research_id, evaluation.yaml and experimental indexes are not prerequisites. The report or conversation preserves claims, source links, gaps and a short continuation note. Experimental tasks progressively load the additional references.

The experimental Agent references are [research protocol](../skills/auto-research/references/research-protocol.md), [experiments and evaluation](../skills/auto-research/references/experimental-research.md) and [safety and recovery](../skills/auto-research/references/experiment-safety.md). SKILL.md only routes to these modules. Old reference filenames redirect to them for compatibility; do not add a second protocol there. Role files define role-specific inputs, tools and outputs.

The default Experimenter declares execution_scope: candidate plus read, bash, notebook_read and notebook_run. CLI/Python scripts use Bash; stateful Python analysis uses Notebook. All Experimenter reads require a server-bound Candidate, even in code-generation mode; an unbound child can use only supplied task text. Candidate execution always forces isolation. Parent Bash/Notebook can run task-specific evaluation scripts and read authorized research files in required mode. The Skill validates known answers, freezes evaluation versions and compares baseline/candidate measurements; no evaluator registration, approval, dedicated tool or JSON-predictions contract is required. Candidate self-reported scores do not replace Parent reevaluation. This provides methodological independence, not protection against a malicious Parent or hidden official scoring. That separate requirement is deferred in the [protected-evaluation RFC](rfcs/protected-evaluation.md).

Tool permissions intersect the Parent's active capabilities and are checked live. Exact authorized scientific/Web Access MCP tools remain Researcher's retrieval path; hidden ask-only calls fail with a permission dependency. No Bash/curl approval bypass, fabricated evidence or automatic host fallback is permitted. Session/Execution/Artifact/Provenance stores remain execution authority.

## Research identities and index

For multi-round experiments, cross-Candidate comparison or experimental recovery needing relationship indexing, research/<id>/manifest.json is the sole semantic relationship index and Experiment completion ledger. A single bounded analysis may cite its protocol, results and real Execution/Artifact references in its report. Source-only tasks use evidence/report checkpoints without empty experimental indexes. The Parent owns writes; children return actual references. File-tool writes use same-directory atomic replacement instead of truncation; after interruption, reread the manifest and reconcile stale state before any retry. A Candidate has approved input and mutable work and may have many Executions. An Experiment is a separately identified controlled hypothesis test with formal evaluation, not a Candidate directory or an invocation. experiments/<experiment-id>/result.json holds scientific details; state.json holds phase/next actions and the manifest revision, not another completed-ID list. Execution status and artifact bytes remain in existing durable stores, not copied into the manifest.

Start from [the empty manifest template](../skills/auto-research/templates/research-manifest.json). Its [read-only validator](../skills/auto-research/scripts/validate-manifest.mjs) checks canonical paths, identities, cross-Candidate references, unique execution links and the required evaluation references for completion. It cannot attest scientific correctness or the existence of durable references; verify those against their stores. This is a file-level Skill convention, not a new server state machine or API. Operator/developer validation:

```bash
node skills/auto-research/scripts/validate-manifest.mjs <workspace>/research/<id>/manifest.json
```

The command checks structure and links, not scientific correctness or permissions. For old experiments/<candidate-id>/ results, create distinct Experiment IDs in the index pointing at original result paths and real execution/evaluation evidence. Preserve old files and checkpoints; reconcile evidence rather than trusting old completion flags. New writes maintain only the manifest ledger. See the research protocol for field definitions and interruption handling.

## Compatibility and verification

sandbox_run remains registered for historical invocation recovery and explicit legacy role declarations; it is absent from the default Experimenter. Read-only replay of a matching authorized historical invocation no longer requires an enabled executor. New invocations retain the old enable/platform/budget gates. No old execution IDs, source/log records, artifact versions or producer names are rewritten. [Compatibility rules and removal gates](sandbox-run-compatibility.md) document remaining differences; full removal is not claimed.

[Universal Sandbox](universal-sandbox.md) owns operator configuration, platform boundaries and OS acceptance commands. [Implementation history](auto-research-history.md) retains version history, failed-platform evidence and old CI counts; none of that belongs in Agent runtime instructions. Current regression coverage checks default role discovery, explicit legacy IPC and replay, Candidate read isolation, the shared Bash/Notebook runtime, manifest relationships and Skill reference routing. Model fixtures validate transport and prescribed outcomes, not scientific reasoning quality. The live DeepSeek test remains opt-in and network-dependent; [current validation and comparison limits](auto-research-validation.md) describe reproduction and observed failures.


## Follow-up design boundaries

PR #162 deliberately retains the existing safe Candidate/budget binding and manifest/checkpoint recovery format. Two subsequent migrations remain proposed, not implemented:

- Auto Research should own Candidate/Experiment IDs, directories and lifecycle. A generic Runtime grant would bind server-validated read/write roots, network policy, tool ceilings and deadlines to the Worker/Execution; `candidate_id` would become correlation metadata. Model-supplied paths must never become authority. Acceptance must preserve confinement, inheritance, revocation, signed kernel identity, old evidence and recovery before replacing the current binding.
- A Parent-written append-only research decision JSONL could replace the independently edited semantic completion ledger, with `manifest.json` as an optional rebuildable projection. This needs locked atomic appends, stable event/idempotency IDs, deterministic replay/reconciliation and staged compatibility tests for existing manifests/checkpoints. Runtime Execution/Artifact stores remain authoritative for actual execution facts. Do not introduce a second writable source of truth during migration.

See [scope migration](universal-sandbox.md#scope-migration-after-upgrade) for the actionable compatibility changes included in this PR.
