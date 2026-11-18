import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionRepository, executionIdFor } from "./execution-repository.js";
import { appendJsonLine, workspaceFile } from "../../storage/persistence.js";
import { InMemorySqliteStateStore, SqliteStateStore } from "../../storage/sqlite/state-store.js";
import { subscribeExecutionEvents } from "./execution-events.js";

const workspaces: string[] = [];
const stores: InMemorySqliteStateStore[] = [];

async function sqliteRepository() {
  const store = new InMemorySqliteStateStore();
  stores.push(store);
  await store.start();
  return new ExecutionRepository(store);
}

async function writeLegacyEvent(cwd: string, executionId: string, sequence: number, payload: object) {
  await appendJsonLine(workspaceFile(cwd, "execution-events-v1.jsonl"), {
    schema_version: 1,
    event_id: `event-${executionId}-${sequence}`,
    execution_id: executionId,
    sequence,
    event_type: sequence === 1 ? "execution.started" : "execution.completed",
    kind: "tool",
    surface: "pi",
    workspace_id: cwd,
    created_at: new Date(sequence * 1000).toISOString(),
    producer: "test",
    payload,
  });
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-science-executions-"));
  workspaces.push(path);
  return path;
}

describe("ExecutionRepository", () => {
  it("stores non-Job executions in SQLite when the application state store is enabled", async () => {
    const cwd = await workspace();
    const state = new InMemorySqliteStateStore();
    await state.start();
    try {
      const repository = new ExecutionRepository(state);
      await repository.start(cwd, {
        execution_id: "exec-sqlite-tool",
        kind: "tool",
        surface: "pi",
        producer: "test",
        correlation: { session_id: "session-sqlite" },
      });
      await repository.finish(cwd, "exec-sqlite-tool", {
        status: "succeeded",
        producer: "test",
        result: { output_preview: "stored" },
      });
      expect(await new ExecutionRepository(state).get(cwd, "exec-sqlite-tool")).toMatchObject({
        status: "succeeded",
        correlation: { session_id: "session-sqlite" },
        result: { output_preview: "stored" },
      });
    } finally {
      await state.close();
    }
  });

  it("paginates SQLite records while returning the full session summary", async () => {
    const cwd = await workspace();
    const state = new InMemorySqliteStateStore();
    await state.start();
    try {
      const repository = new ExecutionRepository(state);
      const created_at = "2026-01-01T00:00:00.000Z";
      for (const [id, session] of [
        ["b", "s1"],
        ["a", "s1"],
        ["other", "s2"],
      ]) {
        await repository.start(cwd, {
          execution_id: id,
          kind: "tool",
          surface: "pi",
          producer: "test",
          created_at,
          correlation: { session_id: session },
        });
      }
      await repository.finish(cwd, "a", {
        status: "succeeded",
        producer: "test",
        ended_at: "2026-01-01T00:00:00.123Z",
      });
      expect(await repository.query(cwd, { session_id: "s1", limit: 1 })).toMatchObject({
        executions: [{ execution_id: "a" }],
        total: 2,
        filtered_total: 2,
        completed_duration_ms: 123,
        completed_duration_count: 1,
        status_counts: { running: 1, succeeded: 1 },
      });
      expect(
        await repository.query(cwd, { session_id: "s1", status: "running", offset: 1 }),
      ).toMatchObject({
        executions: [],
        total: 2,
        filtered_total: 1,
        status_counts: { running: 1, succeeded: 1 },
      });
      expect(await repository.query(cwd, { session_id: "missing" })).toMatchObject({
        executions: [],
        total: 0,
        filtered_total: 0,
        status_counts: {},
      });
    } finally {
      await state.close();
    }
  });

  it("combines SQLite search, time bounds, and target location without changing scope totals", async () => {
    const cwd = await workspace();
    const state = new InMemorySqliteStateStore();
    await state.start();
    try {
      const sqlite = new ExecutionRepository(state);
      const start = "2026-01-01T09:00:00.000Z";
      const end = "2026-01-01T12:00:00.000Z";

      for (const [id, session, created_at, ended_at] of [
        ["b", "s1", start, end],
        ["a", "s1", start, end],
        ["other-session", "s2", start, end],
        ["invalid-end", "s1", start, "invalid"],
        ["before-window", "s1", start, "2026-01-01T09:59:59.999Z"],
        ["no-start", "s1", "invalid", end],
      ] as const) {
        await sqlite.start(cwd, {
          execution_id: id,
          kind: "tool",
          surface: "pi",
          producer: "test",
          created_at,
          correlation: { session_id: session },
        });
        await sqlite.finish(cwd, id, {
          status: "succeeded",
          producer: "test",
          ended_at,
          result: { output_preview: "ÜBER 中文" },
        });
      }
      await sqlite.start(cwd, {
        execution_id: "running",
        kind: "tool",
        surface: "pi",
        producer: "test",
        created_at: start,
        correlation: { session_id: "s1" },
        request: { input: { title: "ÜBER 中文" } },
      });

      const filters = {
        session_id: "s1",
        kind: "tool",
        status: "succeeded",
        search: "über 中文",
        from: "2026-01-01T11:00:00+01:00",
        to: "2026-01-01T11:00:00.000Z",
        limit: 1,
      } as const;
      expect(await sqlite.query(cwd, { ...filters, target_id: "b" })).toMatchObject({
        executions: [{ execution_id: "a" }],
        total: 6,
        filtered_total: 2,
        status_counts: { running: 1, succeeded: 5 },
        target_offset: 1,
        target_in_scope: true,
        target_matches: true,
      });
      for (const [target_id, target_in_scope] of [
        ["running", true], ["other-session", false], ["missing", false],
      ] as const) {
        expect(await sqlite.query(cwd, { ...filters, target_id })).toMatchObject({
          target_in_scope, target_matches: false, target_offset: null,
        });
      }
      expect(await sqlite.query(cwd, { ...filters, status: "running", target_id: "running" }))
        .toMatchObject({
          executions: [{ execution_id: "running" }],
          total: 6,
          filtered_total: 1,
          target_offset: 0,
          target_matches: true,
        });
    } finally {
      await state.close();
    }
  });

  it("preserves newer SQLite execution status when legacy rows are imported again", async () => {
    const cwd = await workspace();
    const state = new SqliteStateStore({ path: join(cwd, "state.sqlite") });
    await state.start();
    try {
      const repository = new ExecutionRepository(state);
      const executionId = "legacy-run";
      const artifact = { artifact_id: "legacy-artifact", version: 2, relation: "output" };
      await writeLegacyEvent(cwd, executionId, 1, {
        correlation: { session_id: "legacy-session", tool_call_id: "legacy-call" },
      });
      const completedId = "legacy-completed-run";
      await writeLegacyEvent(cwd, completedId, 1, {
        correlation: { session_id: "legacy-session", tool_call_id: "legacy-call" },
      });
      await writeLegacyEvent(cwd, completedId, 2, { artifacts: [artifact] });
      expect(await repository.importLegacy([cwd])).toEqual({ records: 2 });
      expect(await repository.get(cwd, completedId)).toMatchObject({
        execution_id: completedId,
        status: "succeeded",
        correlation: { session_id: "legacy-session", tool_call_id: "legacy-call" },
        artifacts: [artifact],
      });
      await repository.finish(cwd, executionId, {
        status: "succeeded",
        producer: "test",
        result: { output_preview: "kept" },
      });

      await state.close();
      await state.start();
      expect(await repository.importLegacy([cwd])).toEqual({ records: 0 });
      await writeLegacyEvent(cwd, "another-legacy-run", 1, {});
      expect(await repository.importLegacy([cwd])).toEqual({ records: 1 });
      expect(await repository.get(cwd, executionId)).toMatchObject({
        status: "succeeded",
        result: { output_preview: "kept" },
      });
    } finally {
      await state.close();
    }
  });

  it("reduces a lifecycle into one queryable execution", async () => {
    const cwd = await workspace();
    const repository = await sqliteRepository();
    const started = await repository.start(cwd, {
      execution_id: "exec-test",
      kind: "job",
      surface: "local",
      producer: "test",
      correlation: { job_id: "job-1", session_id: "session-1" },
      request: { command: ["python", "analysis.py"] },
    });
    expect(started.status).toBe("running");

    const finished = await repository.finish(cwd, started.execution_id, {
      status: "succeeded",
      producer: "test",
      result: { exit_code: 0, stdout_preview: "done" },
      files: { written: [{ path: "results/out.csv", detection: "snapshot" }] },
    });
    expect(finished).toMatchObject({
      execution_id: "exec-test",
      status: "succeeded",
      correlation: { job_id: "job-1", session_id: "session-1" },
      result: { exit_code: 0, stdout_preview: "done" },
    });
    expect(finished?.files.written).toEqual([{ path: "results/out.csv", detection: "snapshot" }]);
    await expect(repository.list(cwd, { session_id: "session-1" })).resolves.toHaveLength(1);
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "lost"] as const)(
    "reads retired sandbox_run %s evidence without an executor or replay",
    async (status) => {
      const cwd = await workspace();
      const repository = await sqliteRepository();
      const execution_id = executionIdFor(
        "sandbox_run",
        "historical-session",
        "historical-operation",
        "historical-call",
      );
      const request = {
        candidate_id: "candidate-001",
        research_id: "study-1",
        code: "print('historical')",
        code_sha256: "historical-code-digest",
        timeout_seconds: 60,
      };
      const result = {
        execution_id,
        status,
        stdout: "historical output\n",
        stderr: "historical diagnostic",
        artifact_refs: [{ artifact_id: "historical-artifact", version: 2, relation: "output" }],
      };
      await repository.start(cwd, {
        execution_id,
        kind: "tool",
        surface: "python",
        producer: "sandbox_run",
        request,
      });
      await repository.finish(cwd, execution_id, {
        status,
        producer: "sandbox_run",
        result,
        artifacts: [{ artifact_id: "historical-artifact", version: 2, relation: "output" }],
      });
      expect(await repository.get(cwd, execution_id)).toMatchObject({
        producer: "sandbox_run",
        status,
        request,
        result,
        artifacts: [{ artifact_id: "historical-artifact", version: 2, relation: "output" }],
      });
      expect(await repository.list(cwd)).toHaveLength(1);
    },
  );

  it("is idempotent for duplicate starts and terminal updates", async () => {
    const cwd = await workspace();
    const repository = await sqliteRepository();
    const input = {
      execution_id: "exec-idempotent",
      kind: "tool" as const,
      surface: "pi" as const,
      producer: "test",
    };
    await repository.start(cwd, input);
    await repository.start(cwd, input);
    await repository.finish(cwd, input.execution_id, {
      status: "failed",
      producer: "test",
      result: { error: "first" },
    });
    await repository.finish(cwd, input.execution_id, { status: "succeeded", producer: "test" });
    expect((await repository.get(cwd, input.execution_id))?.status).toBe("failed");
  });

  it("keeps the first terminal result across SQLite connections", async () => {
    const cwd = await workspace();
    const path = join(cwd, "state.sqlite");
    const firstStore = new SqliteStateStore({ path });
    const secondStore = new SqliteStateStore({ path });
    try {
      await firstStore.start();
      await secondStore.start();
      const first = new ExecutionRepository(firstStore);
      const second = new ExecutionRepository(secondStore);
      const { execution_id } = await first.start(cwd, {
        kind: "tool",
        surface: "pi",
        producer: "test",
      });
      const [left, right] = await Promise.all([
        first.finish(cwd, execution_id, { status: "succeeded", producer: "one" }),
        second.finish(cwd, execution_id, { status: "failed", producer: "two" }),
      ]);
      expect(left?.status).toMatch(/^(succeeded|failed)$/);
      expect(right).toEqual(left);
      expect(await first.get(cwd, execution_id)).toEqual(left);
    } finally {
      await Promise.all([firstStore.close(), secondStore.close()]);
    }
  });

  it("derives stable ids from source identities", () => {
    expect(executionIdFor("tool", "session", "call")).toBe(
      executionIdFor("tool", "session", "call"),
    );
    expect(executionIdFor("tool", "session", "call")).not.toBe(
      executionIdFor("tool", "session", "other"),
    );
  });

  it("notifies workspace subscribers only after a new event is persisted", async () => {
    const cwd = await workspace();
    const repository = await sqliteRepository();
    const received: string[] = [];
    const unsubscribe = subscribeExecutionEvents(cwd, (event) => received.push(event.event_type));

    const input = {
      execution_id: "exec-live",
      kind: "tool" as const,
      surface: "pi" as const,
      producer: "test",
    };
    await repository.start(cwd, input);
    await repository.start(cwd, input);
    await repository.finish(cwd, input.execution_id, { status: "succeeded", producer: "test" });
    await repository.finish(cwd, input.execution_id, {
      status: "failed",
      producer: "test",
      result: { error: "admission failed", stderr_preview: "old error" },
    });

    expect(received).toEqual(["execution.started", "execution.completed"]);
    unsubscribe();
  });
});

it("lets only the authoritative job repair an earlier terminal projection", async () => {
  const cwd = await workspace();
  const repository = await sqliteRepository();
  const input = {
    execution_id: "job-repair",
    kind: "job" as const,
    surface: "local" as const,
    producer: "test",
    correlation: { job_id: "job-authority" },
  };
  await repository.start(cwd, input);
  await repository.finish(cwd, input.execution_id, {
    status: "failed",
    producer: "test",
    result: { error: "admission failed", stderr_preview: "old error" },
  });
  expect(
    (
      await repository.finish(cwd, input.execution_id, {
        status: "succeeded",
        producer: "test",
        authoritative_job_id: "wrong-job",
      })
    )?.status,
  ).toBe("failed");
  expect(
    (
      await repository.finish(cwd, input.execution_id, {
        status: "succeeded",
        producer: "test",
        authoritative_job_id: "job-authority",
        result: { exit_code: 0, stdout_preview: "done" },
      })
    )?.status,
  ).toBe("succeeded");
  await repository.finish(cwd, input.execution_id, {
    status: "succeeded",
    producer: "test",
    authoritative_job_id: "job-authority",
  });
  expect((await repository.get(cwd, input.execution_id))?.result).toEqual({
    exit_code: 0,
    stdout_preview: "done",
  });
});
