import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionRecord } from "@pi-science/contracts";
import { runsQuery, sessionRunsQuery } from "./runs";

function record(status: ExecutionRecord["status"]): ExecutionRecord {
  return {
    schema_version: 1,
    execution_id: `exec_${status}`,
    kind: "tool",
    surface: "pi",
    status,
    workspace_id: "/workspace",
    created_at: "2026-08-15T01:00:00.000Z",
    producer: "test",
    correlation: {},
    request: {},
    runtime: {},
    result: {},
    files: { read: [], written: [] },
    artifacts: [],
  };
}

describe("runsQuery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes active executions quickly and idle ledgers quietly", () => {
    const interval = runsQuery("/workspace").refetchInterval;
    expect(typeof interval).toBe("function");
    if (typeof interval !== "function") return;
    expect(interval({ state: { data: [record("running")] } })).toBe(5_000);
    expect(interval({ state: { data: [record("succeeded")] } })).toBe(30_000);
    expect(interval({ state: {} })).toBe(30_000);
  });

  it("requests only the selected session for the inspector", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ executions: [record("succeeded")] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await sessionRunsQuery("/workspace/demo", "session-1").queryFn();

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("session_id=session-1"), expect.anything());
  });
});

it("reproduction includes recorded evidence and requires confirmation before execution", async () => {
  const { reproduceRunPrompt } = await import("./runs");
  const run = { ...record("succeeded"), request: { code: "print(42)" }, runtime: { python: "3.12" },
    files: { read: [{ path: "input.csv", detection: "explicit" as const, sha256: "abc" }], written: [] } };
  const prompt = reproduceRunPrompt(run);
  expect(prompt).toContain("not a verified reproduction");
  expect(prompt).toContain("ask for confirmation before re-running");
  expect(prompt).toContain("print(42)");
  expect(prompt).toContain('"sha256": "abc"');
  expect(prompt).toContain('"python": "3.12"');
});
