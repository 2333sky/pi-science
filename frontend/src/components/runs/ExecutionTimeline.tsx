import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExecutionLedgerProps } from "./ExecutionLedger";
import { executionTimeline } from "./timeline";
import { executionDuration, executionLabel, formatTimestamp, isActiveExecution, isProblemExecution } from "./run-formatters";
import { cn } from "../../lib/ui";

export function ExecutionTimeline({ runs, selectedId, onSelect }: ExecutionLedgerProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const active = runs.some(isActiveExecution);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  const timeline = executionTimeline(runs, now);
  return <section tabIndex={0} aria-label={t("runs.timeline")} className="runs-ledger-pane min-w-0 overflow-auto">
    <p className="p-3 text-xs text-muted">{t("runs.timelineHint")}</p>
    <div className="min-w-[480px] px-3 pb-3">
      <div className="mb-3 ml-[150px] flex justify-between gap-2 text-[11px] text-muted"><time>{formatTimestamp(new Date(timeline.start).toISOString())}</time><time>{formatTimestamp(new Date(timeline.end).toISOString())}</time></div>
      {timeline.rows.map(({ run, left, width, known, active: running }) => <button key={run.execution_id} type="button" aria-current={selectedId === run.execution_id ? "true" : undefined} onClick={() => onSelect(run.execution_id)} title={`${executionLabel(run)} · ${t(`runs.status.${run.status}`)} · ${executionDuration(run, t("runs.running"))}`} className={cn("flex min-h-12 w-full items-center gap-3 border-b border-faint text-left", selectedId === run.execution_id && "bg-accent-soft")}>
        <span className="w-[138px] shrink-0 truncate text-xs text-text">{executionLabel(run)}<span className="block text-[10px] text-muted">{t(`runs.status.${run.status}`)}</span></span>
        <span className="relative h-7 flex-1 rounded bg-surface-2">
          {known ? <span data-testid={`timeline-${run.execution_id}`} style={{ left: left === 100 ? "calc(100% - 3px)" : `${left}%`, width: `${width}%`, minWidth: 3 }} className={cn("absolute top-1 h-5 rounded", isProblemExecution(run) ? "bg-error/70" : "bg-accent/70", running && "animate-pulse")} /> : <span className="px-2 text-[11px] text-muted">{t("runs.unknownTiming")}</span>}
        </span>
      </button>)}
    </div>
  </section>;
}
