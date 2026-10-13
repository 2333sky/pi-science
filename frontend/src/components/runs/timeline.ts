import type { ExecutionRecord } from "@pi-science/contracts";

/** Missing/invalid starts and terminal ends are shown separately, never invented. */
export function executionTimeline(runs: ExecutionRecord[], now = Date.now()) {
  const rows = runs.map((run) => {
    const start = Date.parse(run.started_at ?? "");
    const active = run.status === "running" || run.status === "pending";
    const end = run.ended_at ? Date.parse(run.ended_at) : active ? Math.max(start, now) : NaN;
    return { run, start, end, active, known: Number.isFinite(start) && Number.isFinite(end) && end >= start };
  });
  const known = rows.filter((row) => row.known);
  const start = known.length ? Math.min(...known.map((row) => row.start)) : now;
  const end = known.length ? Math.max(...known.map((row) => row.end)) : now;
  const span = Math.max(1, end - start);
  return { start, end, rows: rows.sort((a, b) => (a.known && b.known ? a.start - b.start : Number(b.known) - Number(a.known))).map((row) => ({
    ...row, left: row.known ? 100 * (row.start - start) / span : 0,
    width: row.known ? 100 * (row.end - row.start) / span : 0,
  })) };
}
