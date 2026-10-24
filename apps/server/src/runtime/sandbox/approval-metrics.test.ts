import { expect, it } from "vitest";
import { ApprovalMetrics } from "./approval-metrics.js";
it("bounds samples, separates transitions and excludes failures from successful P95", () => {
  const metrics = new ApprovalMetrics();
  const sample = { from: "ask", to: "auto", result: "success", total_ms: 10, persistence_ms: 1, resource_revoke_ms: 0, worker_restart_count: 0 };
  for (let i = 0; i < 1001; i++) metrics.record(sample);
  expect(metrics.snapshot().samples).toBe(1000);
  metrics.record({ ...sample, from: "full", to: "ask", result: "permission_transition_failed", total_ms: 1000, worker_restart_count: 1 });
  const rows = metrics.snapshot().transitions;
  expect(rows[0]).toMatchObject({ transition: "ask → auto", p95_ms: 10, failures: 0 });
  expect(rows[1]).toMatchObject({ transition: "full → ask", p95_ms: null, failures: 1, slow_changes: 1 });
});
