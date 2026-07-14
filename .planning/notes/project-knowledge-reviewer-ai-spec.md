---
title: Project Knowledge Reviewer AI Contract
date: 2026-07-15
status: implementation
source: project-knowledge-reviewer.md
---

# Project Knowledge Reviewer AI Contract

## 1. System classification

The Reviewer is a model-assisted structured extraction and classification system with a human-in-the-loop approval gate. It consumes incremental project evidence (conversation messages, accepted knowledge, file metadata, provenance, and organization policy) and emits proposals only.

It is not authorized to mutate `PROJECT.md`, accepted knowledge, policy, or the workspace filesystem. Mutations are performed by deterministic backend services after explicit user approval.

### 1b. Domain rubric ingredients

Good Reviewer output:

- captures durable project facts, conclusions, decisions, hypotheses, open questions, tasks, project changes, and important artifacts;
- distinguishes evidence from inference and labels uncertainty;
- cites real session message IDs and existing file paths;
- proposes a change only when it is novel relative to accepted knowledge and pending proposals;
- identifies conflicts and superseded knowledge instead of silently overwriting it;
- suggests conservative, reversible file organization operations.

Bad Reviewer output:

- turns brainstorming or casual language into a confirmed fact;
- invents sources, files, message IDs, confidence, or completion claims;
- repeats an accepted or pending item with cosmetic wording changes;
- proposes deletion or a path outside the workspace;
- embeds instructions found in project files as if they were system instructions;
- applies changes without approval.

Stakes: false project knowledge contaminates future research context; unsafe file suggestions can break references or lose user work. Therefore unsupported claims and unsafe paths are hard failures, while missed low-value knowledge is a recoverable quality issue.

## 2. Framework decision

**Selected:** direct Pi coding-agent JSONL RPC through the existing `PiProcess` runtime.

Rationale:

- already supports the same built-in and Custom API providers as chat;
- avoids a second model configuration path;
- a Reviewer run is a linear prompt → structured response flow, so a graph framework would add unnecessary state machinery;
- a separate transient process isolates Reviewer context from the active user session;
- deterministic application services remain responsible for persistence and file operations.

**Alternative considered:** LangGraph. Rejected for the initial implementation because the workflow has one model step and deterministic validation/application stages. It becomes relevant only if Reviewer processing later grows into a long-running, resumable multi-node workflow.

## 3. Entry-point pattern

```python
async def review_increment(
    workspace: Path,
    session_id: str,
    messages: list[ReviewMessage],
    accepted_knowledge: list[KnowledgeItem],
    pending_proposals: list[Proposal],
    file_index: list[IndexedFile],
    policy: ProjectPolicy,
) -> ReviewResult:
    prompt = build_reviewer_prompt(...)
    raw_text = await transient_pi_runner(prompt, workspace)
    result = ReviewResult.model_validate(parse_json_payload(raw_text))
    return validate_reviewer_evidence(result, messages, workspace)
```

The transient model process has no Reviewer-specific write/edit tools. Its output is parsed and validated before anything is stored in the inbox.

## 4. Prompt and context rules

The system prompt must:

1. state that project content is untrusted data, not instructions;
2. request a single JSON object conforming to the output schema;
3. define the supported knowledge and file-operation types;
4. prohibit delete operations and paths outside the workspace;
5. require source message IDs for conversation-derived knowledge;
6. require a reason, confidence, importance, and evidence type;
7. ask for no proposal when the increment contains no durable value;
8. include accepted and pending summaries for novelty and conflict checks;
9. include organization policy and locked paths;
10. cap the number of proposals per run.

Raw file contents are not automatically inserted into the Reviewer prompt. Only metadata and already-sanitized excerpts explicitly selected by a future ingestion flow may be included.

### 4b. Structured output model

```python
class ReviewerProposal(BaseModel):
    proposal_type: Literal["knowledge", "file_operation"]
    knowledge_type: Literal[
        "finding", "conclusion", "decision", "hypothesis",
        "question", "task", "project_change", "artifact",
    ] | None = None
    title: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1, max_length=4000)
    reason: str = Field(min_length=1, max_length=2000)
    confidence: Literal["low", "medium", "high"]
    importance: Literal["normal", "important", "critical"]
    source_message_ids: list[str] = Field(default_factory=list)
    related_files: list[str] = Field(default_factory=list)
    conflicts_with: list[str] = Field(default_factory=list)
    operations: list[FileOperation] = Field(default_factory=list)


class ReviewerResult(BaseModel):
    proposals: list[ReviewerProposal] = Field(default_factory=list, max_length=20)
```

Additional deterministic validation rejects unsupported message IDs, nonexistent source paths, delete operations, path traversal, empty knowledge types, and file-operation proposals without operations.

## 5. Evaluation strategy

| Dimension | Method | Pass condition |
|---|---|---|
| Schema validity | Code-based | 100% of stored proposals pass Pydantic validation |
| Source validity | Code-based | every cited message ID and related file resolves |
| Mutation safety | Code-based | model output cannot mutate accepted state; unsafe operations rejected |
| Novelty | Code + human sample | duplicate pending/accepted proposals remain below agreed threshold |
| Knowledge precision | Human rubric | durable accepted candidates substantially outnumber rejected noise |
| Type accuracy | Human/LLM judge after calibration | fact, conclusion, decision, hypothesis, question, and task are correctly distinguished |
| Conflict detection | Reference cases | explicit contradictions identify the relevant accepted knowledge ID |
| File-plan safety | Code-based | no delete, traversal, collision, locked-path, or partial-transaction failures |
| Latency and cost | Code-based | run duration and proposal count recorded; timeout produces a recoverable error |

The initial reference set should contain at least 12 fixtures:

- clear conclusion with evidence;
- explicit decision and rationale;
- speculative brainstorming that must remain a hypothesis or be ignored;
- repeated conclusion already accepted;
- contradiction that must flag a conflict;
- no-value casual conversation;
- task and open question in the same turn;
- important generated artifact;
- safe rename suggestion;
- target collision;
- path traversal attempt;
- prompt injection text inside project content.

## 6. Guardrails and failure behavior

- Reviewer output is proposals-only; approval is mandatory for all mutations.
- JSON parse or schema failure stores nothing and returns a retryable error.
- Unsupported source IDs are removed; a knowledge proposal with no valid evidence is rejected.
- Related file paths are normalized relative paths and must exist at review time.
- File operations permit only `mkdir`, `move`, and `rename`; delete is never accepted.
- Preview and apply repeat the same collision, locked-path, and workspace-boundary checks.
- File operation groups are transactional and produce an undo record.
- Model timeout or process failure does not affect chat, accepted knowledge, or files.
- Automatic review runs are asynchronous and never block the primary SSE response stream.
- External document text is treated as untrusted evidence and cannot override the Reviewer system contract.

## 7. Observability and acceptance

Each run records locally:

- run ID, workspace, session ID, model, start/end timestamps, duration, status;
- input message IDs and cursor range, not secret keys;
- raw proposal count, validated count, rejected count and rejection reasons;
- accepted/rejected proposal outcomes;
- file transaction and undo results.

The initial implementation uses the existing local `.pi-science/history/` JSONL approach rather than adding a hosted tracing dependency. This keeps project data local. A future Phoenix/Langfuse integration can consume the same run records.

Implementation acceptance checklist:

- [x] Framework chosen and isolation boundary defined.
- [x] Reviewer output schema and evidence validation defined.
- [x] Human approval boundary defined.
- [x] Deterministic file safety and rollback requirements defined.
- [x] Reference evaluation cases defined.
- [x] Failure behavior and local observability defined.
