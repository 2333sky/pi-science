import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { citationVerifyService, extractCitations, MAX_CITATIONS_PER_CALL, type CitationDeps } from "./citation-verify-service.js";

const workspaces: string[] = [];
const FAST: CitationDeps["minimumInterval"] = { "api.crossref.org": 0, "api.unpaywall.org": 0, "export.arxiv.org": 0 };

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-citations-"));
  workspaces.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  return cwd;
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function xmlResponse(xml: string): Response {
  return { ok: true, status: 200, text: async () => xml } as unknown as Response;
}

/** Crossref record shape as returned for a live DOI; the retraction fixtures
 *  below use the real relation layout observed on api.crossref.org. */
const crossrefRecord = (message: Record<string, unknown>) => jsonResponse({ status: "ok", message });

function crossrefFetch(message: Record<string, unknown>, extra: (url: URL) => Response | null = () => null) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const handled = extra(url);
    if (handled) return handled;
    if (url.host === "api.crossref.org") return crossrefRecord(message);
    return jsonResponse({ status: "resource not found" }, 404);
  });
}

const arxivFeed = ({ id, title, summary, published }: { id: string; title: string; summary: string; published: string }): string =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/${id}</id><published>${published}T00:00:00Z</published><title>${title}</title><summary>${summary}</summary><author><name>Ada Lovelace</name></author></entry></feed>`;

async function cacheRows(cwd: string): Promise<string> {
  return readFile(join(cwd, ".pi-science", "citations.jsonl"), "utf8").catch(() => "");
}

describe("extractCitations", () => {
  it("keeps one reference per source and remembers the cited arXiv version", () => {
    const text = "See arXiv:2401.12345v1, then arXiv:2401.12345v2, and arXiv:1706.03762.";
    expect(extractCitations(text)).toEqual([
      { kind: "arxiv", id: "2401.12345", requested_id: "2401.12345v1", requested_version: "1" },
      { kind: "arxiv", id: "1706.03762", requested_id: "1706.03762", requested_version: null },
    ]);
  });

  it("dedupes DOIs case-insensitively and keeps first-seen order across kinds", () => {
    const text = "10.1038/ABC then arXiv:2401.12345 then 10.1038/abc.";
    expect(extractCitations(text)).toEqual([
      { kind: "doi", id: "10.1038/abc", requested_id: "10.1038/abc", requested_version: null },
      { kind: "arxiv", id: "2401.12345", requested_id: "2401.12345", requested_version: null },
    ]);
  });

  it("strips trailing punctuation but keeps dots inside a DOI suffix", () => {
    expect(extractCitations("see 10.1234/abc.def.")).toEqual([{ kind: "doi", id: "10.1234/abc.def", requested_id: "10.1234/abc.def", requested_version: null }]);
  });

  it("terminates DOI matches at CJK text and fullwidth punctuation", () => {
    const text = "AlphaFold 蛋白结构预测方法见 10.1038/s41586-020-2649-2，另见 arXiv:1706.03762。";
    expect(extractCitations(text)).toEqual([
      { kind: "doi", id: "10.1038/s41586-020-2649-2", requested_id: "10.1038/s41586-020-2649-2", requested_version: null },
      { kind: "arxiv", id: "1706.03762", requested_id: "1706.03762", requested_version: null },
    ]);
  });
});

describe("citationVerifyService.verify", () => {
  it("reports source metadata without claiming the claim is supported", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch({
        title: ["Attention Is All You Need"],
        author: [{ given: "Ashish", family: "Vaswani" }],
        "container-title": ["Nature"],
        issued: { "date-parts": [[2017]] },
        abstract: "<p>The Transformer architecture.</p>",
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(cwd, { text: "The Transformer (10.1038/x) changed everything." }, deps);
    expect(result.citations[0]).toMatchObject({
      kind: "doi", id: "10.1038/x", status: "found", title: "Attention Is All You Need", journal: "Nature", year: "2017",
      retraction: "clear", checked_providers: ["crossref"], error: null, version: "not_applicable", cached: false,
    });
    expect(await cacheRows(cwd)).toContain("10.1038/x");
  });

  it("reuses a fresh snapshot without contacting providers again", async () => {
    const cwd = await makeWorkspace();
    const fetchMock = crossrefFetch({ title: ["One Paper"], author: [], issued: { "date-parts": [[2020]] } }) as unknown as typeof fetch;
    await citationVerifyService.verify(cwd, { text: "10.1038/one" }, { fetch: fetchMock, minimumInterval: FAST });
    const again = await citationVerifyService.verify(cwd, { text: "10.1038/one again" }, { fetch: fetchMock, minimumInterval: FAST });
    expect(again.citations[0]).toMatchObject({ id: "10.1038/one", cached: true, status: "found" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-queries providers when a manual retry asks for a refresh", async () => {
    const cwd = await makeWorkspace();
    const fetchMock = crossrefFetch({ title: ["One Paper"], author: [], issued: { "date-parts": [[2020]] } }) as unknown as typeof fetch;
    await citationVerifyService.verify(cwd, { text: "10.1038/one" }, { fetch: fetchMock, minimumInterval: FAST });
    const refreshed = await citationVerifyService.verify(cwd, { text: "10.1038/one", refresh: true }, { fetch: fetchMock, minimumInterval: FAST });
    expect(refreshed.citations[0]).toMatchObject({ id: "10.1038/one", cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names the source that answered when a DOI is not in Crossref", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = { minimumInterval: FAST, fetch: vi.fn(async () => jsonResponse({ status: "resource not found" }, 404)) };
    const result = await citationVerifyService.verify(cwd, { text: "Ghost cite 10.9999/nothing." }, deps);
    // Crossref does not register every DOI, so the state says which source missed.
    expect(result.citations[0]).toMatchObject({ status: "not_found", checked_providers: ["crossref"], retraction: "unknown", title: null });
  });

  it("reports a rate limit as a failed lookup and does not cache it as a missing paper", async () => {
    const cwd = await makeWorkspace();
    const limited: CitationDeps = { minimumInterval: FAST, fetch: vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch };
    const failed = await citationVerifyService.verify(cwd, { text: "10.1038/limited" }, limited);
    expect(failed.citations[0]).toMatchObject({ status: "error", retraction: "unknown" });
    expect(failed.citations[0]!.error).toContain("HTTP 429");
    expect(await cacheRows(cwd)).not.toContain("10.1038/limited");

    const recovered: CitationDeps = { minimumInterval: FAST, fetch: crossrefFetch({ title: ["Recovered Paper"], author: [], issued: { "date-parts": [[2021]] } }) as unknown as typeof fetch };
    const retried = await citationVerifyService.verify(cwd, { text: "10.1038/limited" }, recovered);
    expect(retried.citations[0]).toMatchObject({ status: "found", title: "Recovered Paper", cached: false });
  });

  it("reads a retraction notice reported on the original record", async () => {
    // Live shape of 10.1016/s0140-6736(97)11096-0: the notice lives in updated-by.
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch({
        title: ["RETRACTED: Ileal-lymphoid-nodular hyperplasia"],
        author: [],
        issued: { "date-parts": [[1998]] },
        "updated-by": [{ DOI: "10.1016/S0140-6736(10)60175-4", type: "retraction", label: "Retraction", source: "retraction-watch", updated: { "date-parts": [[2010, 2, 6]] } }],
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(cwd, { text: "10.1016/s0140-6736(97)11096-0" }, deps);
    expect(result.citations[0]).toMatchObject({ status: "found", retraction: "retracted", retraction_url: "https://doi.org/10.1016/S0140-6736(10)60175-4" });
    expect(result.citations[0]!.retraction_note).toContain("Retraction");
  });

  it("reads a retraction relation reported on the notice record", async () => {
    // Live shape of 10.1016/s0140-6736(10)60175-4: the notice points back through update-to.
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: crossrefFetch({
        title: ["Retraction—Ileal-lymphoid-nodular hyperplasia"],
        author: [],
        issued: { "date-parts": [[2010]] },
        "update-to": [{ DOI: "10.1016/s0140-6736(97)11096-0", type: "retraction", label: "Retraction", source: "retraction-watch" }],
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(cwd, { text: "10.1016/s0140-6736(10)60175-4" }, deps);
    expect(result.citations[0]).toMatchObject({ retraction: "retracted", retraction_url: "https://doi.org/10.1016/s0140-6736(97)11096-0" });
  });

  it("keeps the retraction state clear when no notice is reported", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = { minimumInterval: FAST, fetch: crossrefFetch({ title: ["Clean Paper"], author: [], issued: { "date-parts": [[2019]] }, "updated-by": [] }) as unknown as typeof fetch };
    const result = await citationVerifyService.verify(cwd, { text: "10.1038/clean" }, deps);
    expect(result.citations[0]).toMatchObject({ status: "found", retraction: "clear", retraction_note: null });
  });

  it("confirms the cited arXiv version when the feed serves it", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({ id: "2401.12345v1", title: "Paper Title", summary: "A summary.", published: "2024-01-22" });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    const result = await citationVerifyService.verify(cwd, { text: "As shown in arXiv:2401.12345v1." }, { fetch: fetchMock, minimumInterval: FAST });
    expect(result.citations[0]).toMatchObject({
      kind: "arxiv", id: "2401.12345", requested_id: "2401.12345v1", requested_version: "1", status: "found",
      title: "Paper Title", abstract: "A summary.", oa_url: "https://arxiv.org/abs/2401.12345",
      version: "confirmed", record_version: "1",
    });
    const requested = String(new URL(String((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])).searchParams.get("id_list"));
    expect(requested).toBe("2401.12345");
  });

  it("marks a version mismatch without passing the current abstract off as the cited one", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({ id: "2401.12345v1", title: "Paper Title", summary: "Summary of version one.", published: "2024-01-22" });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    const result = await citationVerifyService.verify(cwd, { text: "As shown in arXiv:2401.12345v2." }, { fetch: fetchMock, minimumInterval: FAST });
    expect(result.citations[0]).toMatchObject({ status: "found", version: "unconfirmed", record_version: "1", abstract: null });
  });

  it("labels an unversioned arXiv citation as version unconfirmed and keeps the current abstract", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({ id: "2401.12345v2", title: "Paper Title", summary: "Summary of version two.", published: "2024-01-22" });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    const result = await citationVerifyService.verify(cwd, { text: "As shown in arXiv:2401.12345." }, { fetch: fetchMock, minimumInterval: FAST });
    expect(result.citations[0]).toMatchObject({ requested_version: null, version: "unconfirmed", record_version: "2", abstract: "Summary of version two." });
  });

  it("reports the arXiv retraction state as unknown instead of claiming it is clean", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({ id: "2401.12345v1", title: "Paper Title", summary: "A summary.", published: "2024-01-22" });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    const result = await citationVerifyService.verify(cwd, { text: "arXiv:2401.12345" }, { fetch: fetchMock, minimumInterval: FAST });
    expect(result.citations[0]).toMatchObject({ retraction: "unknown", retraction_note: "arXiv does not publish retraction metadata" });
  });

  it("keeps one failed lookup from failing the whole batch", async () => {
    const cwd = await makeWorkspace();
    const deps: CitationDeps = {
      minimumInterval: FAST,
      fetch: vi.fn(async (input: string | URL | Request) => {
        if (new URL(String(input)).host === "api.crossref.org") return crossrefRecord({ title: ["Known Paper"], author: [], issued: { "date-parts": [[2020]] } });
        throw new Error("network down");
      }) as unknown as typeof fetch,
    };
    const result = await citationVerifyService.verify(cwd, { text: "10.1038/known and arXiv:2401.12345" }, deps);
    expect(result.citations[0]).toMatchObject({ id: "10.1038/known", status: "found" });
    expect(result.citations[1]).toMatchObject({ kind: "arxiv", status: "error" });
    expect(result.citations[1]!.error).toContain("network down");
  });

  it("reports the citations it did not process instead of truncating silently", async () => {
    const cwd = await makeWorkspace();
    const text = Array.from({ length: MAX_CITATIONS_PER_CALL + 2 }, (_, index) => `10.1038/paper-${index}`).join(" ");
    const deps: CitationDeps = { minimumInterval: FAST, fetch: crossrefFetch({ title: ["Batch Paper"], author: [], issued: { "date-parts": [[2020]] } }) as unknown as typeof fetch };
    const result = await citationVerifyService.verify(cwd, { text }, deps);
    expect(result.total).toBe(MAX_CITATIONS_PER_CALL + 2);
    expect(result.processed).toBe(MAX_CITATIONS_PER_CALL);
    expect(result.citations).toHaveLength(MAX_CITATIONS_PER_CALL);
    expect(result.unprocessed.map((ref) => ref.id)).toEqual(["10.1038/paper-30", "10.1038/paper-31"]);
  });
});

describe("citationVerifyService.lookup", () => {
  it("returns the source snapshot for the version that was cited", async () => {
    const cwd = await makeWorkspace();
    const xml = arxivFeed({ id: "2401.12345v1", title: "Cached Paper", summary: "A summary.", published: "2024-01-22" });
    const fetchMock = vi.fn(async () => xmlResponse(xml)) as unknown as typeof fetch;
    await citationVerifyService.verify(cwd, { text: "arXiv:2401.12345v1" }, { fetch: fetchMock, minimumInterval: FAST });

    const [confirmed] = await citationVerifyService.lookup(cwd, ["arxiv:2401.12345v1"]);
    expect(confirmed).toMatchObject({ title: "Cached Paper", version: "confirmed", record_version: "1", cached: true });
    // A different version reads the same source snapshot but must not claim
    // that snapshot describes the cited text.
    const [mismatch] = await citationVerifyService.lookup(cwd, ["arxiv:2401.12345v2"]);
    expect(mismatch).toMatchObject({ id: "2401.12345", requested_version: "2", version: "unconfirmed" });
    expect(await citationVerifyService.lookup(cwd, ["arxiv:9999.99999", "bogus:x"])).toEqual([]);
  });

  it("returns cached DOI snapshots without network access", async () => {
    const cwd = await makeWorkspace();
    await citationVerifyService.verify(cwd, { text: "10.1038/cached" }, {
      minimumInterval: FAST,
      fetch: crossrefFetch({ title: ["Cached Paper"], author: [], issued: { "date-parts": [[2021]] } }) as unknown as typeof fetch,
    });
    const hits = await citationVerifyService.lookup(cwd, ["doi:10.1038/cached", "doi:10.1038/missing"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "10.1038/cached", title: "Cached Paper", version: "not_applicable", cached: true });
  });
});
