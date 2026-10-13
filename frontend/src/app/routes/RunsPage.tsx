import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Braces, FileSearch, Loader2, Play, Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { ExecutionRecord } from "@pi-science/contracts";
import { cn, useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { fileInspectorForPath } from "../../lib/artifacts";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { useTranslation } from "react-i18next";
import { reproduceRunPrompt, runLogQuery, runsPageQuery } from "../../lib/runs";
import { subscribeExecutionInvalidation } from "../../lib/runs/execution-events";
import { apiRequest } from "../../lib/client/api";
import { useFeedback } from "../../components/feedback/feedback-context";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";
import { ExecutionDetails } from "../../components/runs/ExecutionDetails";
import { ExecutionTimeline } from "../../components/runs/ExecutionTimeline";
import { ExecutionLedger } from "../../components/runs/ExecutionLedger";
import type { DetailTab } from "../../components/runs/run-types";
import { fileName, isActiveExecution, workspaceRelativePath } from "../../components/runs/run-formatters";

type KindFilter = "all" | ExecutionRecord["kind"];
type StatusFilter = "all" | ExecutionRecord["status"];

const KINDS: ExecutionRecord["kind"][] = ["tool", "kernel_cell", "job", "research_agent", "research_evaluation"];
const STATUSES: ExecutionRecord["status"][] = ["pending", "running", "succeeded", "failed", "timed_out", "cancelled", "interrupted", "lost"];
const EMPTY_RUNS: ExecutionRecord[] = [];

export function RunsPage({ sessionId }: { sessionId?: string } = {}) {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const navigate = useNavigate();
  const workspaceCwd = useRequiredWorkspaceCwd();
  const openInspector = useUiStore((state) => state.openInspector);
  const setComposerDraft = useRuntimeStore((state) => state.setDraft);
  const [searchParams, setSearchParams] = useSearchParams();
  const contextSessionId = sessionId || searchParams.get("session_id") || undefined;
  const activeSessionId = searchParams.get("scope") === "workspace" ? undefined : contextSessionId;
  const [offset, setOffset] = useState(0);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [view, setView] = useState<"list" | "timeline">("list");
  const [groupBySession, setGroupBySession] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const [compactDetailOpen, setCompactDetailOpen] = useState(() => searchParams.has("execution"));
  const [liveConnected, setLiveConnected] = useState(false);

  const invalidRange = Boolean(from && to && from > to);
  const runsResult = useQuery({ ...runsPageQuery(workspaceCwd, {
    session_id: activeSessionId, search: search.trim(),
    kind: kind === "all" ? undefined : kind, status: status === "all" ? undefined : status,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined, offset, limit: 50,
  }, liveConnected), enabled: !invalidRange });
  const runs = invalidRange ? EMPTY_RUNS : runsResult.data?.executions ?? EMPTY_RUNS;
  const total = runsResult.data?.total ?? runs.length;
  const filteredTotal = runsResult.data?.filtered_total ?? runs.length;
  const scopeLabel = activeSessionId ? t("runs.currentSession") : t("runs.workspaceScope");
  const loading = runsResult.isFetching;
  const selectedId = searchParams.get("execution");
  const hasSessionKernel = Boolean(sessionId && activeSessionId === sessionId && runs.some((run) => run.kind === "kernel_cell"));

  useEffect(() => { setOffset(0); }, [activeSessionId, workspaceCwd]);

  useEffect(() => subscribeExecutionInvalidation(workspaceCwd, { onConnectionChange: setLiveConnected }), [workspaceCwd]);

  const filteredRuns = runs;

  const changeScope = (scope: string) => {
    const next = new URLSearchParams(searchParams);
    next.delete("execution");
    if (contextSessionId) next.set("session_id", contextSessionId);
    next.set("scope", scope);
    setOffset(0);
    setCompactDetailOpen(false);
    setSearchParams(next);
  };

  const selected = filteredRuns.find((run) => run.execution_id === selectedId);

  useEffect(() => {
    const first = filteredRuns[0];
    if (!first || selected) return;
    const next = new URLSearchParams(searchParams);
    next.set("execution", first.execution_id);
    setSearchParams(next, { replace: true });
  }, [filteredRuns, searchParams, selected, setSearchParams]);

  const runsError = runsResult.error;
  useEffect(() => {
    if (runsError) toast(runsError instanceof Error ? runsError.message : t("runs.loadError"), "error");
  }, [runsError, t, toast]);

  const logQuery = runLogQuery(workspaceCwd, selected?.execution_id ?? "");
  const logResult = useQuery({
    ...logQuery,
    queryKey: [...logQuery.queryKey, selected?.status, selected?.ended_at, JSON.stringify(selected?.result)],
    enabled: Boolean(selected && detailTab === "output"),
    refetchInterval: selected && isActiveExecution(selected) && detailTab === "output" ? 5_000 : false,
  });
  const logText = logResult.data ? [logResult.data.stdout, logResult.data.stderr].filter(Boolean).join("\n") : undefined;
  useEffect(() => {
    if (logResult.error) toast(logResult.error instanceof Error ? logResult.error.message : t("runs.logError"), "error");
  }, [logResult.error, t, toast]);

  const selectExecution = (executionId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("execution", executionId);
    setSearchParams(next);
    setDetailTab("summary");
    setCompactDetailOpen(true);
  };

  const copyText = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(message, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : t("runs.copyError"), "error");
    }
  };

  const openFile = (path: string) => {
    const relative = workspaceRelativePath(path, workspaceCwd);
    if (!relative) {
      toast(t("runs.fileOutsideWorkspace"), "error");
      return;
    }
    openInspector(fileInspectorForPath(relative, fileName(relative), "workspace", workspaceCwd));
  };

  const openArtifact = async (artifact: ExecutionRecord["artifacts"][number]) => {
    try {
      const manifest = await apiRequest<{ path: string }>(`/api/artifacts/${encodeURIComponent(artifact.artifact_id)}?${new URLSearchParams({ cwd: workspaceCwd, version: String(artifact.version) })}`);
      openFile(manifest.path);
    } catch (error) {
      toast(error instanceof Error ? error.message : t("runs.artifactLoadError"), "error");
    }
  };

  const openSession = (run: ExecutionRecord) => {
    const root = `/workspace/${encodeURIComponent(workspaceCwd)}`;
    navigate(run.correlation.session_id ? `${root}/session/${encodeURIComponent(run.correlation.session_id)}` : root);
  };

  const locateExecution = (run: ExecutionRecord) => {
    const toolCallId = run.correlation.tool_call_id;
    if (!toolCallId) return;
    const next = new URLSearchParams(searchParams);
    next.delete("view");
    next.delete("execution");
    next.set("focus", `tool-${toolCallId}`);
    setSearchParams(next);
  };

  const reproduce = (run: ExecutionRecord) => {
    setComposerDraft(reproduceRunPrompt(run));
    openSession(run);
  };

  return (
    <WorkspacePage>
      <WorkspacePageHeader
        title={t("runs.title")}
        description={`${scopeLabel}${activeSessionId ? ` · ${activeSessionId}` : ""} · ${t("runs.pageCount", { total, filtered: filteredTotal, visible: runs.length })}`}
        actions={<>
          {hasSessionKernel && (
            <button
              type="button"
              onClick={() => openInspector({ variant: "notebook-panel" })}
              className="flex min-h-9 items-center gap-1.5 rounded-input border border-border bg-surface px-3 text-xs font-medium text-text transition-colors hover:border-accent-border hover:bg-accent-soft hover:text-accent"
            >
              <Braces size={14} /> {t("notebook.openSessionKernel")}
            </button>
          )}
          <WorkspacePageRefreshButton label={t("common.refresh")} loading={loading} onClick={() => void runsResult.refetch()} />
        </>}
      />

      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-text">
        <select aria-label={t("runs.scope")} value={activeSessionId ? "session" : "workspace"} onChange={(event) => changeScope(event.target.value)} className="min-h-9 rounded-input border border-border bg-surface px-3">
          {contextSessionId && <option value="session">{t("runs.currentSession")}</option>}
          <option value="workspace">{t("runs.workspaceScope")}</option>
        </select>
        <select aria-label={t("runs.view")} value={view} onChange={(event) => setView(event.target.value as "list" | "timeline")} className="min-h-9 rounded-input border border-border bg-surface px-3">
          <option value="list">{t("runs.list")}</option><option value="timeline">{t("runs.timeline")}</option>
        </select>
        {view === "list" && <label className="flex items-center gap-2"><input type="checkbox" checked={groupBySession} onChange={(event) => setGroupBySession(event.target.checked)} />{t("runs.groupSession")}</label>}
        <label>{t("runs.from")} <input aria-label={t("runs.from")} type="datetime-local" value={from} onChange={(event) => { setFrom(event.target.value); setOffset(0); }} className="rounded-input border border-border bg-surface p-2" /></label>
        <label>{t("runs.to")} <input aria-label={t("runs.to")} type="datetime-local" value={to} onChange={(event) => { setTo(event.target.value); setOffset(0); }} className="rounded-input border border-border bg-surface p-2" /></label>
        {invalidRange && <p role="alert" className="text-error-text">{t("runs.invalidRange")}</p>}
      </div>
      <div className="runs-toolbar mt-5 flex flex-wrap items-center gap-2 rounded-card border border-border p-2">
        <label className="relative min-w-[220px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            aria-label={t("runs.search")}
            value={search}
            onChange={(event) => { setSearch(event.target.value); setOffset(0); }}
            placeholder={t("runs.searchPlaceholder")}
            className="min-h-9 w-full rounded-input border border-border bg-surface pl-9 pr-3 text-xs text-text outline-none transition-colors placeholder:text-muted focus:border-accent"
          />
        </label>
        <select aria-label={t("runs.kindFilter")} value={kind} onChange={(event) => { setKind(event.target.value as KindFilter); setOffset(0); }} className="min-h-9 rounded-input border border-border bg-surface px-3 text-xs text-text outline-none focus:border-accent">
          <option value="all">{t("runs.allKinds")}</option>
          {KINDS.map((item) => <option key={item} value={item}>{t(`runs.kind.${item}`)}</option>)}
        </select>
        <select aria-label={t("runs.statusFilter")} value={status} onChange={(event) => { setStatus(event.target.value as StatusFilter); setOffset(0); }} className="min-h-9 rounded-input border border-border bg-surface px-3 text-xs text-text outline-none focus:border-accent">
          <option value="all">{t("runs.allStatuses")}</option>
          {STATUSES.map((item) => <option key={item} value={item}>{t(`runs.status.${item}`)}</option>)}
        </select>
        <span className="flex items-center gap-1.5 px-1.5 text-[10px] font-medium text-muted" title={t("runs.liveHint")}>
          <span className={cn("h-1.5 w-1.5 rounded-full", liveConnected ? (runs.some(isActiveExecution) ? "animate-pulse bg-accent" : "bg-ok") : "animate-pulse bg-muted")} />
          {t("runs.live")}
        </span>
      </div>

      <div className="runs-workbench-container mt-4">
        {loading && runs.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted"><Loader2 size={18} className="mx-auto mb-2 animate-spin" />{t("common.loading")}</div>
        ) : runs.length === 0 && !search && kind === "all" && status === "all" && !from && !to ? (
          <EmptyState icon={<Play size={40} />} title={t("runs.empty")} hint={t("runs.emptyHint")} />
        ) : filteredRuns.length === 0 ? (
          <EmptyState icon={<FileSearch size={36} />} title={t("runs.noMatches")} hint={t("runs.noMatchesHint")} />
        ) : (
          <div data-testid="runs-workbench" data-compact-detail={compactDetailOpen ? "true" : "false"} className="runs-ledger-layout runs-workbench grid min-h-[540px] overflow-hidden rounded-card border border-border bg-surface">
            {view === "timeline" ? <ExecutionTimeline runs={filteredRuns} selectedId={selected?.execution_id ?? null} onSelect={selectExecution} /> : <ExecutionLedger
              groupBySession={groupBySession}
              runs={filteredRuns}
              selectedId={selected?.execution_id ?? null}
              onSelect={selectExecution}
            />}
            <section aria-label={t("runs.details")} className="runs-detail-pane min-w-0 bg-bg/40">
              {selected && <ExecutionDetails
                run={selected}
                tab={detailTab}
                onTabChange={setDetailTab}
                onBack={() => setCompactDetailOpen(false)}
                onCopy={(text, message) => void copyText(text, message)}
                onOpenFile={openFile}
                onOpenArtifact={(artifact) => void openArtifact(artifact)}
                onOpenSession={selected.correlation.session_id && selected.correlation.session_id !== sessionId ? () => openSession(selected) : undefined}
                onLocate={sessionId && selected.correlation.session_id === sessionId && selected.correlation.tool_call_id ? () => locateExecution(selected) : undefined}
                onReproduce={() => reproduce(selected)}
                log={logResult.data ? { text: logText || t("runs.noLog"), complete: logResult.data.complete } : logResult.error ? { text: t("runs.logLoadFailed"), complete: false } : undefined}
                loadingLog={logResult.isFetching}
              />}
            </section>
          </div>
        )}
      </div>
      <nav aria-label={t("runs.pagination")} className="mt-4 flex items-center justify-between gap-3 text-xs text-text">
        <button type="button" disabled={offset === 0 || loading} onClick={() => { setOffset(Math.max(0, offset - 50)); setCompactDetailOpen(false); }} className="rounded-input border border-border px-3 py-2 disabled:opacity-40">{t("runs.previous")}</button>
        <span>{t("runs.pagePosition", { from: runs.length ? offset + 1 : 0, to: offset + runs.length, total: filteredTotal })}</span>
        <button type="button" disabled={offset + runs.length >= filteredTotal || loading || invalidRange} onClick={() => { setOffset(offset + 50); setCompactDetailOpen(false); }} className="rounded-input border border-border px-3 py-2 disabled:opacity-40">{t("runs.next")}</button>
      </nav>
    </WorkspacePage>
  );
}

function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return <div className="py-16 text-center"><div className="mx-auto mb-3 w-fit text-muted/30">{icon}</div><p className="text-sm text-muted">{title}</p><p className="mt-1 text-xs text-muted">{hint}</p></div>;
}
