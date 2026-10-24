import { channel } from "node:diagnostics_channel";

type Sample = { from?: string; to: string; result: string; total_ms: number; persistence_ms: number; resource_revoke_ms: number; worker_restart_count: number; kernel_restart_count?: number; mcp_reconnect_count?: number };
/** Bounded process-local samples, with no session IDs, paths, arguments or credentials. */
export class ApprovalMetrics {
  private readonly samples: Sample[] = [];
  record(value: Sample) {
    this.samples.push({ from: value.from, to: value.to, result: value.result, total_ms: value.total_ms, persistence_ms: value.persistence_ms,
      resource_revoke_ms: value.resource_revoke_ms, worker_restart_count: value.worker_restart_count, kernel_restart_count: value.kernel_restart_count ?? 0, mcp_reconnect_count: value.mcp_reconnect_count ?? 0 });
    if (this.samples.length > 1000) this.samples.shift();
  }
  snapshot() {
    const groups = new Map<string, Sample[]>();
    for (const sample of this.samples) { const key = `${sample.from ?? "unknown"} → ${sample.to}`; groups.set(key, [...(groups.get(key) ?? []), sample]); }
    return { window: 1000, samples: this.samples.length, transitions: [...groups].map(([transition, samples]) => {
      const times = samples.filter((s) => s.result === "success").map((s) => s.total_ms).sort((a, b) => a - b);
      const percentile = (p: number) => times.length ? times[Math.ceil(times.length * p) - 1]! : null;
      return { transition, count: samples.length, failures: samples.filter((s) => s.result !== "success").length,
        p50_ms: percentile(0.5), p95_ms: percentile(0.95), slow_changes: samples.filter((s) => s.total_ms >= 300).length,
        worker_restarts: samples.reduce((sum, s) => sum + s.worker_restart_count, 0), kernel_restarts: samples.reduce((sum, s) => sum + (s.kernel_restart_count ?? 0), 0) };
    }) };
  }
}
export const approvalMetrics = new ApprovalMetrics();
channel("pi-science.approval-change").subscribe((sample) => approvalMetrics.record(sample as Sample));
