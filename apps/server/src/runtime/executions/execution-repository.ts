import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  executionEventSchema,
  executionRecordSchema,
  type ExecutionArtifactRef,
  type ExecutionCorrelation,
  type ExecutionEvent,
  type ExecutionEventType,
  type ExecutionFileEvidence,
  type ExecutionKind,
  type ExecutionRecord,
  type ExecutionStatus,
  type ExecutionSurface,
} from "@pi-science/contracts";
import { configPath, readJsonLines, workspaceFile } from "../../storage/persistence.js";
import { emitExecutionEvent } from "./execution-events.js";
import { workspaceIdentity } from "../agent/workspace-session-identity.js";
import { parseExecutionRecord } from "./execution-search.js";
import { SqliteStateStore } from "../../storage/sqlite/state-store.js";
import type { SqlStatement } from "../../storage/sqlite/protocol.js";

const EXECUTION_LOG = "execution-events-v1.jsonl";
const TERMINAL_STATUSES = new Set<ExecutionStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "lost",
]);

export interface StartExecutionInput {
  execution_id?: string;
  kind: ExecutionKind;
  surface: ExecutionSurface;
  producer: string;
  created_at?: string;
  correlation?: ExecutionCorrelation;
  request?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  files?: Partial<{ read: ExecutionFileEvidence[]; written: ExecutionFileEvidence[] }>;
  artifacts?: ExecutionArtifactRef[];
}

export interface FinishExecutionInput {
  /** A durable Job may repair a failed admission/projection attempt. Other
   * producers retain first-terminal-wins semantics. Verified again under lock. */
  authoritative_job_id?: string;
  status: Exclude<ExecutionStatus, "pending" | "running">;
  producer: string;
  ended_at?: string;
  result?: Record<string, unknown>;
  files?: Partial<{ read: ExecutionFileEvidence[]; written: ExecutionFileEvidence[] }>;
  artifacts?: ExecutionArtifactRef[];
  usage?: Record<string, unknown>;
}

export function executionIdFor(...parts: string[]): string {
  return `exec_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

export interface ExecutionQuery {
  limit?: number;
  target_id?: string;
  offset?: number;
  session_id?: string;
  kind?: ExecutionKind;
  status?: ExecutionStatus;
  search?: string;
  from?: string;
  to?: string;
}

async function fileSignature(path: string): Promise<string | null> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class ExecutionRepository {
  constructor(private readonly store?: SqliteStateStore) {}

  // App and Worker callers share their managed store. Standalone callers open
  // the same durable database for the duration of the operation.
  private async withStore<T>(operation: (store: SqliteStateStore) => Promise<T>): Promise<T> {
    if (this.store) return operation(this.store);
    const store = new SqliteStateStore({ path: configPath("state.sqlite") });
    try {
      await store.start();
      return await operation(store);
    } finally {
      await store.close();
    }
  }

  private async readLegacyEvents(cwd: string): Promise<ExecutionEvent[]> {
    const rows = await readJsonLines<unknown>(workspaceFile(cwd, EXECUTION_LOG));
    return rows.flatMap((row) => {
      const parsed = executionEventSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async importLegacy(workspaces: readonly string[]): Promise<{ records: number }> {
    return this.withStore(async (store) => {
      let records = 0;
      for (const cwd of workspaces) {
        const path = workspaceFile(cwd, EXECUTION_LOG);
        const signature = await fileSignature(path);
        if (!signature) continue;
        const source = `execution:${resolve(path)}`;
        const imported = await store.get<{ source_fingerprint: string }>(
          "SELECT source_fingerprint FROM legacy_imports WHERE source = ?",
          [source],
        );
        if (imported?.source_fingerprint === signature) continue;
        const workspacePath = workspaceIdentity(cwd);
        const reduced = reduceExecutionEvents(await this.readLegacyEvents(cwd));
        const results = await store.batch([
          ...reduced.map((record) =>
            executionRecordInsert({ ...record, workspace_id: workspacePath }),
          ),
          {
            sql: `INSERT INTO legacy_imports (source, source_fingerprint, imported_at, row_count)
              VALUES (?, ?, ?, ?) ON CONFLICT(source) DO UPDATE SET
              source_fingerprint = excluded.source_fingerprint,
              imported_at = excluded.imported_at,
              row_count = excluded.row_count`,
            params: [source, signature, Date.now(), reduced.length],
          },
        ]);
        records += results.slice(0, -1).reduce((sum, result) => sum + Number(result.changes), 0);
      }
      return { records };
    });
  }

  async list(cwd: string, options: ExecutionQuery = {}): Promise<ExecutionRecord[]> {
    return (await this.query(cwd, options)).executions;
  }

  async query(cwd: string, options: ExecutionQuery = {}) {
    const limit = Number.isFinite(options.limit)
      ? Math.min(1_000, Math.max(1, Math.floor(options.limit!)))
      : 100;
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset!)) : 0;
    return this.withStore((store) => this.queryPage(store, cwd, options, limit, offset));
  }

  private async queryPage(
    store: SqliteStateStore,
    cwd: string,
    options: ExecutionQuery,
    limit: number,
    offset: number,
  ) {
    const sessionId = options.session_id;
    const needle = options.search?.trim().toLocaleLowerCase() || null;
    // Reuse expensive search results as IDs only. Plain pages can read in index order.
    const matchesHint = needle || options.target_id ? "MATERIALIZED" : "NOT MATERIALIZED";
    const row = await store.get<{
      page: string;
      status_counts: string;
      total: number;
      filtered_total: number;
      completed_duration_ms: number;
      completed_duration_count: number;
      target_in_scope: number;
      target_index: number | null;
    }>(
      `WITH scope AS NOT MATERIALIZED (
        SELECT execution_id, created_at, record_json,
          json_extract(record_json, '$.kind') AS kind,
          json_extract(record_json, '$.status') AS status,
          execution_timestamp(json_extract(record_json, '$.started_at')) AS started,
          execution_timestamp(json_extract(record_json, '$.ended_at')) AS ended,
          nullif(json_extract(record_json, '$.ended_at'), '') AS recorded_end
        FROM execution_records
        WHERE workspace_path = ?1
          ${sessionId ? "AND json_extract(record_json, '$.correlation.session_id') = ?11" : ""}
      ), counts AS (
        SELECT status, count(*) AS total,
          sum(CASE WHEN ended >= started THEN ended - started ELSE 0 END) AS duration_ms,
          count(CASE WHEN ended >= started THEN 1 END) AS duration_count
        FROM scope
        GROUP BY status
      ), intervals AS NOT MATERIALIZED (
        SELECT *, CASE
          WHEN recorded_end IS NOT NULL THEN ended
          WHEN status IN ('pending', 'running') THEN max(?8, started)
          ELSE started
        END AS effective_end
        FROM scope
      ), matched AS ${matchesHint} (
        SELECT execution_id, created_at FROM intervals
        WHERE (?2 IS NULL OR kind = ?2) AND (?3 IS NULL OR status = ?3)
          AND ((?6 IS NULL AND ?7 IS NULL) OR (
            effective_end >= started
            AND (?6 IS NULL OR effective_end >= execution_timestamp(?6))
            AND (?7 IS NULL OR started <= execution_timestamp(?7))
          ))
          AND CASE WHEN ?9 IS NULL THEN 1 ELSE execution_matches_search(record_json, ?9) END
      ), page AS (
        SELECT execution_id, created_at FROM matched
        ORDER BY created_at DESC, execution_id ASC LIMIT ?4 OFFSET ?5
      )
      SELECT (
          SELECT json_group_array(r.record_json ORDER BY p.created_at DESC, p.execution_id ASC)
          FROM page p JOIN execution_records r USING (execution_id)
        ) AS page,
        CASE WHEN ?2 IS NULL AND ?3 IS NULL AND ?6 IS NULL AND ?7 IS NULL AND ?9 IS NULL
          THEN coalesce(sum(total), 0)
          ELSE (SELECT count(*) FROM matched)
        END AS filtered_total,
        CASE WHEN ?10 IS NULL THEN 0 ELSE EXISTS (
          SELECT 1 FROM scope WHERE execution_id = ?10
        ) END AS target_in_scope,
        (
          SELECT (SELECT count(*) FROM matched preceding
            WHERE preceding.created_at > target.created_at OR
              (preceding.created_at = target.created_at AND preceding.execution_id < target.execution_id)
          )
          FROM matched target WHERE target.execution_id = ?10
        ) AS target_index,
        json_group_object(status, total) AS status_counts,
        coalesce(sum(total), 0) AS total,
        coalesce(sum(duration_ms), 0) AS completed_duration_ms,
        coalesce(sum(duration_count), 0) AS completed_duration_count
      FROM counts`,
      [
        workspaceIdentity(cwd),
        options.kind ?? null,
        options.status ?? null,
        limit,
        Math.min(offset, Number.MAX_SAFE_INTEGER),
        options.from || null,
        options.to || null,
        Date.now(),
        needle,
        options.target_id || null,
        ...(sessionId ? [sessionId] : []),
      ],
    );
    if (!row) throw new Error("Execution page query returned no summary");
    return {
      total: row.total,
      filtered_total: row.filtered_total,
      completed_duration_ms: row.completed_duration_ms,
      completed_duration_count: row.completed_duration_count,
      executions: (JSON.parse(row.page) as string[]).map(parseExecutionRecord).filter(isRecord),
      status_counts: JSON.parse(row.status_counts) as Partial<Record<ExecutionStatus, number>>,
      ...(options.target_id
        ? {
            target_in_scope: Boolean(row.target_in_scope),
            target_matches: row.target_index !== null,
            target_offset:
              row.target_index === null ? null : Math.floor(row.target_index / limit) * limit,
          }
        : {}),
      limit,
      offset,
    };
  }

  async get(cwd: string, executionId: string): Promise<ExecutionRecord | null> {
    return this.withStore((store) => this.readRecord(store, cwd, executionId));
  }

  private async readRow(store: SqliteStateStore, cwd: string, executionId: string) {
    return store.get<{ record_json: string }>(
      "SELECT record_json FROM execution_records WHERE execution_id = ? AND workspace_path = ?",
      [executionId, workspaceIdentity(cwd)],
    );
  }

  private async readRecord(store: SqliteStateStore, cwd: string, executionId: string) {
    const row = await this.readRow(store, cwd, executionId);
    return row ? parseExecutionRecord(row.record_json) : null;
  }

  async start(cwd: string, input: StartExecutionInput): Promise<ExecutionRecord> {
    const executionId = input.execution_id ?? `exec_${randomUUID().replaceAll("-", "")}`;
    return this.withStore(async (store) => {
      const record = executionRecordFromStart(cwd, executionId, input);
      const result = await store.run(...statementArgs(executionRecordInsert(record)));
      const saved = await this.readRecord(store, cwd, executionId);
      if (!saved) throw new Error(`Execution start was not persisted: ${executionId}`);
      if (Number(result.changes) > 0)
        emitExecutionEvent(cwd, eventFromRecord(record, "execution.started"));
      return saved;
    });
  }

  async finish(
    cwd: string,
    executionId: string,
    input: FinishExecutionInput,
  ): Promise<ExecutionRecord | null> {
    return this.withStore((store) =>
      store.serialized(`execution:${executionId}`, async () => {
        while (true) {
          const row = await this.readRow(store, cwd, executionId);
          if (!row) return null;
          const current = parseExecutionRecord(row.record_json);
          if (!current) return null;
          if (
            TERMINAL_STATUSES.has(current.status) &&
            (current.status === input.status ||
              current.kind !== "job" ||
              !input.authoritative_job_id ||
              current.correlation.job_id !== input.authoritative_job_id)
          )
            return current;
          const event = eventFromFinish(current, input);
          const next = applyExecutionUpdate(current, event);
          // A separate Worker can finish the same execution using its own connection.
          const result = await store.run(
            "UPDATE execution_records SET record_json = ?, updated_at = ? WHERE execution_id = ? AND workspace_path = ? AND record_json = ?",
            [JSON.stringify(next), Date.now(), executionId, current.workspace_id, row.record_json],
          );
          if (Number(result.changes) === 0) continue;
          emitExecutionEvent(cwd, event);
          return next;
        }
      }),
    );
  }
}

function isRecord(record: ExecutionRecord | null): record is ExecutionRecord {
  return record !== null;
}

export function executionRecordFromStart(
  cwd: string,
  executionId: string,
  input: StartExecutionInput,
): ExecutionRecord {
  const startedAt = input.created_at ?? new Date().toISOString();
  return executionRecordSchema.parse({
    schema_version: 1,
    execution_id: executionId,
    kind: input.kind,
    surface: input.surface,
    status: "running",
    workspace_id: workspaceIdentity(cwd),
    created_at: startedAt,
    started_at: startedAt,
    producer: input.producer,
    correlation: input.correlation ?? {},
    request: input.request ?? {},
    runtime: input.runtime ?? {},
    result: {},
    files: { read: input.files?.read ?? [], written: input.files?.written ?? [] },
    artifacts: input.artifacts ?? [],
  });
}

export function executionRecordInsert(record: ExecutionRecord): SqlStatement {
  const createdAt = Date.parse(record.created_at);
  return {
    sql: `INSERT INTO execution_records
      (execution_id, workspace_path, record_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO NOTHING`,
    params: [
      record.execution_id,
      record.workspace_id,
      JSON.stringify(record),
      Number.isFinite(createdAt) ? createdAt : Date.now(),
      Date.now(),
    ],
  };
}

function statementArgs(statement: SqlStatement): [string, NonNullable<SqlStatement["params"]>] {
  return [statement.sql, statement.params ?? []];
}

function eventFromRecord(record: ExecutionRecord, type: ExecutionEventType): ExecutionEvent {
  return executionEventSchema.parse({
    schema_version: 1,
    event_id: `event_${randomUUID().replaceAll("-", "")}`,
    execution_id: record.execution_id,
    sequence: 1,
    event_type: type,
    kind: record.kind,
    surface: record.surface,
    workspace_id: record.workspace_id,
    created_at: new Date().toISOString(),
    producer: record.producer,
    payload: {
      started_at: record.started_at,
      correlation: record.correlation,
      request: record.request,
      runtime: record.runtime,
      files: record.files,
      artifacts: record.artifacts,
    },
  });
}

function eventFromFinish(current: ExecutionRecord, input: FinishExecutionInput): ExecutionEvent {
  return executionEventSchema.parse({
    schema_version: 1,
    event_id: `event_${randomUUID().replaceAll("-", "")}`,
    execution_id: current.execution_id,
    sequence: 2,
    event_type: eventTypeForStatus(input.status),
    kind: current.kind,
    surface: current.surface,
    workspace_id: current.workspace_id,
    created_at: new Date().toISOString(),
    producer: input.producer,
    payload: {
      status: input.status,
      ended_at: input.ended_at ?? new Date().toISOString(),
      result: input.result ?? {},
      files: { read: input.files?.read ?? [], written: input.files?.written ?? [] },
      artifacts: input.artifacts ?? [],
      ...(input.usage ? { usage: input.usage } : {}),
      ...(current.kind === "job" && input.authoritative_job_id === current.correlation.job_id
        ? { replace_result: true }
        : {}),
    },
  });
}

function reduceExecutionEvents(events: ExecutionEvent[]): ExecutionRecord[] {
  const records = new Map<string, ExecutionRecord>();
  const ordered = events
    .slice()
    .sort(
      (left, right) =>
        left.execution_id.localeCompare(right.execution_id) || left.sequence - right.sequence,
    );
  for (const event of ordered) applyExecutionEvent(records, event);
  return [...records.values()];
}

function applyExecutionEvent(records: Map<string, ExecutionRecord>, event: ExecutionEvent): void {
  const payload = event.payload;
  const previous = records.get(event.execution_id);
  if (!previous) {
    if (event.event_type !== "execution.started") return;
    const parsed = executionRecordSchema.safeParse({
      schema_version: 1,
      execution_id: event.execution_id,
      kind: event.kind,
      surface: event.surface,
      status: "running",
      workspace_id: event.workspace_id,
      created_at: stringValue(payload.started_at) ?? event.created_at,
      started_at: stringValue(payload.started_at) ?? event.created_at,
      producer: event.producer,
      correlation: objectValue(payload.correlation),
      request: objectValue(payload.request),
      runtime: objectValue(payload.runtime),
      result: {},
      files: filesValue(payload.files),
      artifacts: artifactRefs(payload.artifacts),
    });
    if (parsed.success) records.set(event.execution_id, parsed.data);
    return;
  }
  records.set(event.execution_id, applyExecutionUpdate(previous, event));
}

function applyExecutionUpdate(previous: ExecutionRecord, event: ExecutionEvent): ExecutionRecord {
  const payload = event.payload;
  return executionRecordSchema.parse({
    ...previous,
    status: statusForEvent(event),
    ended_at: stringValue(payload.ended_at) ?? previous.ended_at,
    producer: event.producer,
    correlation: { ...previous.correlation, ...objectValue(payload.correlation) },
    request: { ...previous.request, ...objectValue(payload.request) },
    runtime: { ...previous.runtime, ...objectValue(payload.runtime) },
    result: {
      ...(payload.replace_result === true ? {} : previous.result),
      ...objectValue(payload.result),
    },
    files: mergeFiles(previous.files, filesValue(payload.files)),
    artifacts: mergeArtifacts(previous.artifacts, artifactRefs(payload.artifacts)),
    usage: { ...(previous.usage ?? {}), ...objectValue(payload.usage) },
  });
}

function eventTypeForStatus(status: FinishExecutionInput["status"]): ExecutionEventType {
  if (status === "succeeded") return "execution.completed";
  if (status === "cancelled") return "execution.cancelled";
  if (status === "interrupted") return "execution.interrupted";
  return "execution.failed";
}

function statusForEvent(event: ExecutionEvent): ExecutionStatus {
  const explicit = event.payload.status;
  if (typeof explicit === "string") {
    const parsed = executionRecordSchema.shape.status.safeParse(explicit);
    if (parsed.success) return parsed.data;
  }
  if (event.event_type === "execution.completed") return "succeeded";
  if (event.event_type === "execution.cancelled") return "cancelled";
  if (event.event_type === "execution.interrupted") return "interrupted";
  if (event.event_type === "execution.failed") return "failed";
  return "running";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function filesValue(value: unknown): {
  read: ExecutionFileEvidence[];
  written: ExecutionFileEvidence[];
} {
  const object = objectValue(value);
  const parse = (items: unknown): ExecutionFileEvidence[] =>
    Array.isArray(items)
      ? items.flatMap((item) => {
          const parsed = executionFileEvidenceSchemaSafe(item);
          return parsed ? [parsed] : [];
        })
      : [];
  return { read: parse(object.read), written: parse(object.written) };
}

function executionFileEvidenceSchemaSafe(value: unknown): ExecutionFileEvidence | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.path !== "string" || !item.path) return null;
  if (!["explicit", "snapshot", "runtime_audit", "declared"].includes(String(item.detection)))
    return null;
  return item as ExecutionFileEvidence;
}

function artifactRefs(value: unknown): ExecutionArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.artifact_id !== "string" ||
      !Number.isInteger(candidate.version) ||
      !["input", "output"].includes(String(candidate.relation))
    )
      return [];
    return [candidate as ExecutionArtifactRef];
  });
}

function mergeFiles(
  left: { read: ExecutionFileEvidence[]; written: ExecutionFileEvidence[] },
  right: { read: ExecutionFileEvidence[]; written: ExecutionFileEvidence[] },
) {
  const merge = (items: ExecutionFileEvidence[]) => [
    ...new Map(items.map((item) => [`${item.path}\0${item.detection}`, item])).values(),
  ];
  return {
    read: merge([...left.read, ...right.read]),
    written: merge([...left.written, ...right.written]),
  };
}

function mergeArtifacts(
  left: ExecutionArtifactRef[],
  right: ExecutionArtifactRef[],
): ExecutionArtifactRef[] {
  return [
    ...new Map(
      [...left, ...right].map((item) => [
        `${item.artifact_id}\0${item.version}\0${item.relation}`,
        item,
      ]),
    ).values(),
  ];
}

export const executionRepository = new ExecutionRepository();
