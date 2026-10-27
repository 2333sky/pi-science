/**
 * Citation verification against free, public scholarly APIs.
 *
 * Every citation in agent output (DOI or arXiv id) is resolved through
 * Crossref / Unpaywall / arXiv for metadata, abstract and open-access links,
 * plus a retraction check via Crossref update relations. Results are cached in
 * the workspace as source-level evidence snapshots so re-verification is
 * incremental.
 *
 * The snapshot answers "what does the queried source hold for this id". It
 * never claims that the paper supports the sentence citing it: that judgement
 * belongs to the conversation model. A provider answer, a provider failure and
 * a version mismatch are three different states and are reported as such.
 */
import { createHash } from "node:crypto";
import { appendJsonLine, configPath, readJson, readJsonLines, workspaceFile } from "../../storage/persistence.js";
import { recordEgress } from "../../security/egress-audit.js";

export type CitationKind = "doi" | "arxiv";
/** `found` and `not_found` are provider answers. `error` is a failed request:
 *  it is reported once and never cached as a bibliographic fact. */
export type CitationStatus = "found" | "not_found" | "error";
/** `clear` means no notice in the sources we queried, never "not retracted". */
export type RetractionState = "retracted" | "clear" | "unknown";
/** arXiv answers with the current version only, so a versioned citation is
 *  confirmed only when the cited version is still the current one. */
export type CitationVersionState = "confirmed" | "unconfirmed" | "not_applicable";

export interface CitationRef {
  kind: CitationKind;
  /** Version-less source identity: the dedupe, query and cache key. */
  id: string;
  /** The identifier as cited, arXiv version suffix included. */
  requested_id: string;
  requested_version: string | null;
}

export interface CitationEvidence {
  /** Rows written before this field existed trusted `update-to` alone, which
   *  misses retractions reported on the original record. */
  schema: 2;
  kind: CitationKind;
  id: string;
  status: CitationStatus;
  title: string | null;
  authors: string[];
  journal: string | null;
  year: string | null;
  abstract: string | null;
  oa_url: string | null;
  retraction: RetractionState;
  retraction_note: string | null;
  retraction_url: string | null;
  /** Sources that answered, so "not found" can name the source that missed. */
  checked_providers: string[];
  /** Provider failure text; set only when status is `error`. */
  error: string | null;
  /** Version the provider record carries now (arXiv only). */
  record_version: string | null;
  verified_at: string;
}

/** One cited identifier joined with the source snapshot, so a stale or
 *  differently versioned snapshot cannot pass for the cited version. */
export interface CitationView extends CitationEvidence {
  requested_id: string;
  requested_version: string | null;
  version: CitationVersionState;
  cached: boolean;
}

export interface VerifyCitationsResult {
  text_sha256: string;
  total: number;
  processed: number;
  unprocessed: CitationRef[];
  citations: CitationView[];
}

export interface CitationDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Per-domain minimum interval in ms, so tests need not sleep. */
  minimumInterval?: Record<string, number>;
}

// DOI suffixes are ASCII per the DOI spec, but the prose around them is not.
// The match must terminate at CJK ideographs/kana/hangul and CJK, fullwidth or
// general punctuation, or a Chinese sentence glues its words onto the id
// ("10.1038/xyz，另见" would otherwise be queried verbatim and fail as
// not_found). Keep in sync with frontend/src/lib/citations/*.
const DOI_PATTERN = /10\.\d{4,9}\/[^\s)\]}>\u2010-\u2027\u2030-\u205e\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]+/gi;
const ARXIV_PATTERN = /arXiv:\s?(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?*"'\u2010-\u2027\u2030-\u205e\u3000-\u303f\uff00-\uffef]+$/;
const ARXIV_VERSION = /v(\d+)$/i;
export const MAX_CITATIONS_PER_CALL = 30;
const MAX_ABSTRACT_CHARS = 2_000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Per-domain minimum interval, mirroring the paper-search connector. */
const MINIMUM_INTERVAL: Record<string, number> = { "api.crossref.org": 50, "api.unpaywall.org": 350, "export.arxiv.org": 3_000 };
const UNPAYWALL_EMAIL_CONFIG = "citation_verify_email";

const lastRequestAt = new Map<string, number>();

function arxivVersion(id: string): string | null {
  return ARXIV_VERSION.exec(id)?.[1] ?? null;
}

/** Extract DOI and arXiv identifiers from text, deduped by source identity in
 *  first-seen order. One logical query per source, even when the same paper is
 *  cited twice, possibly with different arXiv versions.
 *  Rule-compatible with the frontend citations module. */
export function extractCitations(text: string): CitationRef[] {
  const found: Array<CitationRef & { index: number }> = [];
  for (const match of text.matchAll(DOI_PATTERN)) {
    const id = match[0].replace(TRAILING_PUNCTUATION, "").toLowerCase();
    if (id.endsWith("/")) continue;
    found.push({ kind: "doi", id, requested_id: id, requested_version: null, index: match.index ?? 0 });
  }
  for (const match of text.matchAll(ARXIV_PATTERN)) {
    const requestedId = match[1]!;
    found.push({ kind: "arxiv", id: requestedId.replace(ARXIV_VERSION, ""), requested_id: requestedId, requested_version: arxivVersion(requestedId), index: match.index ?? 0 });
  }
  found.sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  const citations: CitationRef[] = [];
  for (const { kind, id, requested_id, requested_version } of found) {
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ kind, id, requested_id, requested_version });
  }
  return citations;
}

function citationCacheFile(cwd: string): string {
  return workspaceFile(cwd, "citations.jsonl");
}

function retractionState(value: unknown): RetractionState {
  return value === "retracted" || value === "clear" ? value : "unknown";
}

function statusState(value: unknown): CitationStatus {
  return value === "not_found" ? "not_found" : value === "error" ? "error" : "found";
}

async function readCache(cwd: string): Promise<Map<string, CitationEvidence>> {
  const rows = await readJsonLines<Record<string, unknown>>(citationCacheFile(cwd));
  const cache = new Map<string, CitationEvidence>();
  for (const row of rows) {
    // Pre-schema rows cannot be trusted for retraction state, and failed
    // requests must never come back as a book that does not exist.
    if (row.schema !== 2 || (row.kind !== "doi" && row.kind !== "arxiv") || typeof row.id !== "string" || typeof row.verified_at !== "string") continue;
    if (statusState(row.status) === "error") continue;
    const key = `${row.kind}:${row.id}`;
    const existing = cache.get(key);
    // Keep the newest snapshot per citation.
    if (existing && existing.verified_at > row.verified_at) continue;
    cache.set(key, {
      schema: 2,
      kind: row.kind,
      id: row.id,
      status: statusState(row.status),
      title: typeof row.title === "string" ? row.title : null,
      authors: Array.isArray(row.authors) ? (row.authors as string[]) : [],
      journal: typeof row.journal === "string" ? row.journal : null,
      year: typeof row.year === "string" ? row.year : null,
      abstract: typeof row.abstract === "string" ? row.abstract : null,
      oa_url: typeof row.oa_url === "string" ? row.oa_url : null,
      retraction: retractionState(row.retraction),
      retraction_note: typeof row.retraction_note === "string" ? row.retraction_note : null,
      retraction_url: typeof row.retraction_url === "string" ? row.retraction_url : null,
      checked_providers: Array.isArray(row.checked_providers) ? (row.checked_providers as string[]) : [],
      error: null,
      record_version: typeof row.record_version === "string" ? row.record_version : null,
      verified_at: row.verified_at,
    });
  }
  return cache;
}

async function throttle(domain: string, deps: CitationDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const interval = deps.minimumInterval?.[domain] ?? MINIMUM_INTERVAL[domain] ?? 350;
  for (;;) {
    const last = lastRequestAt.get(domain) ?? 0;
    const wait = last + interval - now();
    if (wait <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt.set(domain, now());
}

async function fetchJson(url: URL, deps: CitationDeps, domain: string): Promise<unknown> {
  const fetchFn = deps.fetch ?? fetch;
  await throttle(domain, deps);
  await recordEgress({ connector_type: "literature", connector_id: "citation-verify", target_domain: domain, approved: true });
  const response = await fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${domain} returned HTTP ${response.status}`);
  return await response.json();
}

function emptyEvidence(kind: CitationKind, id: string, status: CitationStatus, providers: string[]): CitationEvidence {
  return { schema: 2, kind, id, status, title: null, authors: [], journal: null, year: null, abstract: null, oa_url: null, retraction: "unknown", retraction_note: null, retraction_url: null, checked_providers: providers, error: null, record_version: null, verified_at: new Date().toISOString() };
}

/** Crossref registers an update relation on both records: the notice carries
 *  `update-to` (pointing at the original), the original carries `updated-by`
 *  (pointing at the notice, often with source `retraction-watch`). Reading
 *  only `update-to` reports every retracted paper as clean, so both sides are
 *  read and the first retraction relation wins. */
function retractionFromCrossref(message: Record<string, unknown>): { retraction: RetractionState; note: string | null; url: string | null } {
  const relations = [
    ...(Array.isArray(message["update-to"]) ? (message["update-to"] as Array<Record<string, unknown>>) : []),
    ...(Array.isArray(message["updated-by"]) ? (message["updated-by"] as Array<Record<string, unknown>>) : []),
  ];
  const notice = relations.find((link) => /retract/i.test(String(link.type ?? "")));
  if (notice) {
    return {
      retraction: "retracted",
      note: [notice.label, notice.DOI, notice.source].filter(Boolean).join(" · ") || "A retraction notice is linked to this DOI",
      url: typeof notice.DOI === "string" ? `https://doi.org/${notice.DOI}` : null,
    };
  }
  const assertions = Array.isArray(message.assertion) ? (message.assertion as Array<Record<string, unknown>>) : [];
  const assertionNote = assertions.find((item) => /retract/i.test(String(item.label ?? "")));
  if (assertionNote) return { retraction: "retracted", note: String(assertionNote.label), url: null };
  return { retraction: "clear", note: null, url: null };
}

function crossrefEvidence(doi: string, works: Record<string, unknown>): CitationEvidence {
  const message = (works.message ?? {}) as Record<string, unknown>;
  const issued = (message.issued ?? {}) as Record<string, unknown>;
  const dateParts = Array.isArray(issued["date-parts"]) ? (issued["date-parts"] as number[][]) : [];
  const authors = Array.isArray(message.author) ? (message.author as Array<Record<string, unknown>>).map((author) => [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean) : [];
  const abstract = typeof message.abstract === "string" ? message.abstract.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
  const retraction = retractionFromCrossref(message);
  return {
    ...emptyEvidence("doi", doi, "found", ["crossref"]),
    title: typeof message.title === "string" ? message.title : Array.isArray(message.title) ? String(message.title[0] ?? "") : null,
    authors,
    journal: Array.isArray(message["container-title"]) ? String(message["container-title"][0] ?? "") || null : null,
    year: dateParts[0]?.[0] ? String(dateParts[0][0]) : null,
    abstract: abstract ? abstract.slice(0, MAX_ABSTRACT_CHARS) : null,
    retraction: retraction.retraction,
    retraction_note: retraction.note,
    retraction_url: retraction.url,
  };
}

async function verifyDoi(doi: string, deps: CitationDeps): Promise<CitationEvidence> {
  const works = await fetchJson(new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`), deps, "api.crossref.org") as { message?: Record<string, unknown> } | null;
  // Crossref is one registration agency among several, so a miss here means
  // "not in Crossref", not "this DOI does not exist".
  if (!works?.message) return emptyEvidence("doi", doi, "not_found", ["crossref"]);
  const evidence = crossrefEvidence(doi, works);
  // Unpaywall needs a configured contact email; without one we degrade to
  // Crossref metadata only instead of sending a placeholder address.
  const config = await readJson<Record<string, unknown>>(configPath("config.json"), {});
  const email = String(config[UNPAYWALL_EMAIL_CONFIG] ?? "").trim() || String(process.env.PI_SCIENCE_CITATION_EMAIL ?? "").trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    try {
      const unpaywall = await fetchJson(new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`), deps, "api.unpaywall.org") as Record<string, unknown> | null;
      evidence.checked_providers.push("unpaywall");
      const best = unpaywall?.best_oa_location as Record<string, unknown> | undefined;
      if (best?.url_for_landing_page || best?.url_for_pdf) {
        evidence.oa_url = String(best.url_for_pdf ?? best.url_for_landing_page);
      }
    } catch {
      // Open-access enrichment is best-effort; metadata alone still verifies.
    }
  }
  return evidence;
}

function arxivXmlTag(entry: string, name: string): string {
  return (new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry)?.[1] ?? "").replace(/\s+/g, " ").trim();
}

/** Query the version-less id: arXiv answers with the current version in the
 *  entry's `<id>`. Asking for a version that does not exist returns an empty
 *  feed, which would wrongly read as "this paper does not exist". */
async function verifyArxiv(id: string, requestedVersion: string | null, deps: CitationDeps): Promise<CitationEvidence> {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("id_list", id);
  url.searchParams.set("max_results", "1");
  await throttle("export.arxiv.org", deps);
  await recordEgress({ connector_type: "literature", connector_id: "citation-verify", target_domain: "export.arxiv.org", approved: true });
  const response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`export.arxiv.org returned HTTP ${response.status}`);
  const xml = await response.text();
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1] ?? "";
  if (!entry || /<title>\s*(?:Error|API rate limit exceeded)/i.test(entry)) return emptyEvidence("arxiv", id, "not_found", ["arxiv"]);
  const recordVersion = arxivVersion(arxivXmlTag(entry, "id").replace(/^.*\/abs\//, ""));
  const versionConfirmed = requestedVersion !== null && recordVersion === requestedVersion;
  return {
    ...emptyEvidence("arxiv", id, "found", ["arxiv"]),
    title: arxivXmlTag(entry, "title") || null,
    authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((match) => match[1]!.replace(/\s+/g, " ").trim()).filter(Boolean),
    // The feed only serves the current version. An abstract from a newer
    // version must not be presented as the text of the cited one.
    abstract: requestedVersion === null || versionConfirmed ? arxivXmlTag(entry, "summary").slice(0, MAX_ABSTRACT_CHARS) || null : null,
    year: arxivXmlTag(entry, "published").slice(0, 4) || null,
    oa_url: `https://arxiv.org/abs/${id}`,
    retraction: "unknown",
    retraction_note: "arXiv does not publish retraction metadata",
    record_version: recordVersion,
  };
}

function failedEvidence(ref: CitationRef, error: unknown): CitationEvidence {
  const provider = ref.kind === "doi" ? "crossref" : "arxiv";
  return { ...emptyEvidence(ref.kind, ref.id, "error", [provider]), error: error instanceof Error ? error.message : String(error) };
}

function versionState(evidence: CitationEvidence, requestedVersion: string | null): CitationVersionState {
  if (evidence.kind !== "arxiv") return "not_applicable";
  if (!requestedVersion || !evidence.record_version) return "unconfirmed";
  return requestedVersion === evidence.record_version ? "confirmed" : "unconfirmed";
}

function citationView(evidence: CitationEvidence, ref: CitationRef, cached: boolean): CitationView {
  return { ...evidence, requested_id: ref.requested_id, requested_version: ref.requested_version, version: versionState(evidence, ref.requested_version), cached };
}

function refreshRequested(value: unknown): boolean {
  return value === true;
}

export const citationVerifyService = {
  /** Verify the citations in a text; fresh snapshots are reused until stale.
   *  `refresh` re-queries the providers, which is what a manual retry wants
   *  after a rate limit or a provider outage. */
  async verify(cwd: string, input: { text: string; refresh?: boolean }, deps: CitationDeps = {}): Promise<VerifyCitationsResult> {
    const now = deps.now ?? Date.now;
    const refs = extractCitations(String(input.text ?? ""));
    const batch = refs.slice(0, MAX_CITATIONS_PER_CALL);
    const cache = refreshRequested(input.refresh) ? new Map<string, CitationEvidence>() : await readCache(cwd);
    const results: CitationView[] = [];
    for (const ref of batch) {
      const cached = cache.get(`${ref.kind}:${ref.id}`);
      if (cached && now() - Date.parse(cached.verified_at) < CACHE_TTL_MS) {
        results.push(citationView(cached, ref, true));
        continue;
      }
      let evidence: CitationEvidence;
      try {
        evidence = ref.kind === "doi" ? await verifyDoi(ref.id, deps) : await verifyArxiv(ref.id, ref.requested_version, deps);
      } catch (error) {
        // A provider hiccup must not fail the whole batch, and must not be
        // cached as "this paper does not exist".
        evidence = failedEvidence(ref, error);
      }
      if (evidence.status !== "error") await appendJsonLine(citationCacheFile(cwd), evidence);
      results.push(citationView(evidence, ref, false));
    }
    return {
      text_sha256: createHash("sha256").update(String(input.text ?? "")).digest("hex"),
      total: refs.length,
      processed: batch.length,
      unprocessed: refs.slice(MAX_CITATIONS_PER_CALL),
      citations: results,
    };
  },

  /** Look up source snapshots by composite id without contacting a provider.
   *  The id carries the version that was cited, so the returned view reports
   *  whether that version is the one the snapshot describes. */
  async lookup(cwd: string, ids: string[]): Promise<CitationView[]> {
    const cache = await readCache(cwd);
    return ids.flatMap((raw) => {
      const [kind, ...rest] = raw.split(":");
      const requestedId = rest.join(":");
      if ((kind !== "doi" && kind !== "arxiv") || !requestedId) return [];
      const id = kind === "arxiv" ? requestedId.replace(ARXIV_VERSION, "") : requestedId;
      const hit = cache.get(`${kind}:${id}`);
      if (!hit) return [];
      return [citationView(hit, { kind, id, requested_id: requestedId, requested_version: kind === "arxiv" ? arxivVersion(requestedId) : null }, true)];
    });
  },
};
