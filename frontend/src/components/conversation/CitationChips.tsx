import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Citation } from "../../lib/citations";
import { apiRequest } from "../../lib/client/api";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { cn } from "../../lib/ui";

export interface CitationEvidence {
  kind: "doi" | "arxiv";
  id: string;
  status: "found" | "not_found" | "error";
  title: string | null;
  authors: string[];
  journal: string | null;
  year: string | null;
  retraction: "retracted" | "clear" | "unknown";
  retraction_note: string | null;
  retraction_url: string | null;
  checked_providers: string[];
  error: string | null;
  version: "confirmed" | "unconfirmed" | "not_applicable";
  requested_version: string | null;
  record_version: string | null;
  verified_at: string;
}

type VerifyState = "retracted" | "error" | "found" | "not_found" | "unverified";

/** Chat source chips with source state from the citation snapshots. A found
 *  record means the queried source lists this identifier; it does not mean the
 *  paper supports the sentence citing it. */
export function CitationChips({ citations }: { citations: Citation[] }) {
  const { t } = useTranslation();
  const cwd = useRuntimeStore((state) => state.cwd);
  const ids = citations.map((citation) => `${citation.kind}:${citation.requested_id}`);
  const { data } = useQuery({
    queryKey: ["citations", cwd, ...ids],
    queryFn: () => apiRequest<{ citations: CitationEvidence[] }>(`/api/citations?${new URLSearchParams({ cwd, ids: ids.join(",") })}`),
    enabled: Boolean(cwd) && citations.length > 0,
    staleTime: 60_000,
    retry: false,
  });

  const evidenceBySource = new Map((data?.citations ?? []).map((row) => [`${row.kind}:${row.id}`, row]));
  // The snapshot arrives keyed by source; match on the source so a chip never
  // stays blank because its exact version was not cached.
  const evidenceFor = (citation: Citation): CitationEvidence | undefined => evidenceBySource.get(`${citation.kind}:${citation.id}`);
  const stateFor = (evidence: CitationEvidence | undefined): VerifyState => {
    if (!evidence) return "unverified";
    if (evidence.retraction === "retracted") return "retracted";
    if (evidence.status === "error") return "error";
    if (evidence.status === "found") return "found";
    return "not_found";
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-muted">{t("conversation.sources")} ({citations.length})</span>
      {citations.map((citation, index) => {
        const evidence = evidenceFor(citation);
        const state = stateFor(evidence);
        const detail = [
          evidence?.title ? t("conversation.citationEvidence", { title: evidence.title, year: evidence.year ?? "—" }) : citation.requested_id,
          evidence?.retraction === "retracted" ? t("conversation.citationRetracted") : null,
          state === "error" ? t("conversation.citationLookupFailed", { reason: evidence?.error ?? "" }) : null,
          state === "not_found" ? t("conversation.citationNotInSource", { providers: (evidence?.checked_providers ?? []).join(", ") || "—" }) : null,
          evidence?.version === "unconfirmed" ? t("conversation.citationVersionUnconfirmed", { requested: evidence.requested_version ?? "—", current: evidence.record_version ?? "—" }) : null,
          evidence ? t("conversation.citationCheckedAt", { at: evidence.verified_at }) : null,
        ].filter((part): part is string => Boolean(part));
        const marker = state === "found" ? "✓" : state === "retracted" ? "⚠" : state === "error" ? "!" : state === "not_found" ? "?" : "";
        return (
          <a
            key={`${citation.kind}:${citation.id}`}
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            title={detail.join(" · ")}
            className={cn(
              "rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted hover:text-text",
              state === "retracted" && "border-error-text text-error-text",
              state === "error" && "border-warn-text text-warn-text",
              state === "not_found" && "border-warn-text text-warn-text",
            )}
          >
            {index + 1} · {shortId(citation.requested_id)}{marker && <span className="ml-1" aria-label={t(`conversation.citationState.${state}`)}>{marker}</span>}
          </a>
        );
      })}
    </div>
  );
}

function shortId(id: string): string { return id.length <= 24 ? id : `${id.slice(0, 14)}…${id.slice(-8)}`; }
