# Execution history (#141)

The Runs surface now defaults to the session when entered from its conversation
rail. Workspace entry remains workspace-wide. `session_id` in the Runs URL
preserves that context; `scope=workspace` temporarily broadens it while retaining
the session for switching back. Session membership requires an exact recorded
`correlation.session_id`; unassociated records belong only to workspace scope.

## Query and display contracts

`GET /api/executions` accepts `limit` (1–1000), `offset` (nonnegative integer),
`session_id`, `kind`, `status`, `search`, `from`, and `to`. Time bounds are inclusive
and apply to `created_at`. The UI sends UTC ISO timestamps converted from the
user's local datetime input. Search examines recorded request, result, correlation,
file, and artifact evidence before pagination. Ordering is newest creation time
first, with execution ID as a deterministic tie breaker.

- `total`: all executions within the selected session/workspace scope.
- `filtered_total`: matches after search/type/status/time filters, before slicing.
- `executions`: the requested page; the UI uses 50 rows per page.

Additional metadata is optional in the shared schema to preserve compatibility
with existing callers/fixtures; the server always supplies it. Legacy inspector
queries still return arrays, and session inspectors request their session directly.

Lists show recorded session ownership, status, result/error previews, and output
counts. Session grouping and the timeline operate on the current page and say so.
The timeline uses a shared absolute timestamp axis, preserving overlap. Running
executions extend to now; terminal executions without valid start/end timestamps
are marked unavailable. Zero duration remains zero in the model, with a minimum
3px visual marker for discoverability. These bars express timing, never dependency.
Selection reuses the detail panel. Narrow layouts scroll the timeline within its
pane rather than expanding the document.

Output fallback combines stdout and tool/result previews, and stderr with errors,
deduplicating equal strings. Preview logs always report `complete=false`; Job logs
use the job store's truncation flags. Active log data refreshes and terminal updates
invalidate its view so an initially empty preview cannot remain stuck. Code,
output/errors, file hashes/artifact versions, and scalar environment details appear
before expandable raw JSON.

## Reproduction boundary

The operation is explicitly **Ask AI to attempt reproduction** and creates a
reviewable draft. Its evidence includes the recorded request/code, input and output
file hashes, artifact versions, environment, result, and correlation. It asks for
condition checks, explanation of missing inputs/environment/kernel state, and user
confirmation before execution; truncated code must not be guessed. It does not
claim to have run or verified anything.

This implements P0/P1 and the reproduction honesty/evidence and scaling groundwork
in P2. The umbrella issue remains open for an executor that restores versioned
inputs and environments, isolates state, confirms the execution, and compares
outputs/artifact hashes. Arbitrary tools and stateful kernels do not yet have the
recorded conditions required to promise deterministic reproduction. Experiment
DAGs remain future work; no relationships are inferred from chronological order.

## JSONL performance

A synthetic local benchmark seeded one valid start event per execution, then made
three full-history search queries with offset 100 and limit 50 (Node 24.19).
Before caching, repeated 50,000-event/16.8MB queries took 466–475ms. After a bounded
materialization, repeated queries took 29–30ms (cold read 447ms); 10,000-event
queries took 5–6ms warm versus 91–113ms before. These are illustrative measurements,
not production performance guarantees.

JSONL remains authoritative. The cache skips repeated read/schema validation/event
reduction while the inode/size/nanosecond modification and change timestamps match.
Writes invalidate it; external changes are detected on the next query. A changed
file during reading is not cached. Retention is at most four workspaces and 100,000
records combined; response clones prevent callers mutating cached evidence. Search
and sorting still run over the selected materialization, while every append still
reads the event log for idempotency/sequence validation. Larger histories or write
rates warrant a durable incremental index rather than further cache expansion.

## Verification

Repository/API tests cover lifecycle and cache invalidation, strict session scope,
125-row pagination, search beyond the first 100, time bounds, malformed requests,
and preview fallback. Frontend tests cover navigation scope, server filtering,
paging reset, time range validation, waterfall positions/degradation, selection,
logs, files, and reproduction evidence. Browser tests exercise desktop/mobile
pagination and timeline/detail navigation, horizontal overflow, and axe checks.
