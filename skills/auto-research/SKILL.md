---
name: auto-research
description: Investigate scientific evidence with a lightweight literature workflow, or run bounded experiments with task-specific evaluation and reproducible checkpoints.
version: 1.5.0
license: Apache-2.0
category: research
risk: medium
required_tools: [read, write]
---

# Auto Research

The current conversation Agent owns the question, evidence, optional delegation and stopping. Use existing tools and history; never start a separate coordinator. Choose the smallest workflow that answers the question.

- **Literature / Research Lite**: search, read, verify sources and synthesize a report. Read only [literature research](references/literature-research.md). No execution_budget, research_id binding, Candidate, evaluator, manifest or separate state file is required. Use supplied evidence when retrieval tools are unavailable. Stay in this mode unless computation or experimental comparison is actually needed.
- **Experimental Research**: before computation or Candidate implementation, read [research protocol](references/research-protocol.md), [experiments and evaluation](references/experimental-research.md) and [safety and recovery](references/experiment-safety.md). Write a versioned evaluation.yaml. This mode requires execution_budget and authorized sandboxed Bash/Notebook; bind research_id, max_seconds and max_executions before the first execution/delegation. Reuse the binding on continuation; a used unbound budget cannot be rebound. Report missing capabilities without host fallback.

Delegation is optional. Built-in roles are auto-research/researcher, auto-research/experimenter and auto-research/reviewer; use only available authorized roles. Retrieval-only delegation uses ordinary runtime limits and does not require research_id. Candidate isolation is enforced by the server-bound execution_scope: candidate declaration and assigned candidate_id, never by role-name text.

Use the full manifest only for multi-round experiments, cross-Candidate comparison or experimental recovery needing a relationship index. A single bounded analysis can retain its protocol, result and actual Execution/Artifact references in the report. Do not initialize empty indexes for literature work. When present, manifest.json is the sole experiment completion ledger; the strict validator still applies. Existing Session/Execution/Artifact/Provenance records remain authoritative. Never fabricate references, invent a universal quality score or equate process success or Reviewer PASS with scientific success.
