import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteratureService, deduplicate } from "./literature-service.js";
import type { LiteratureSearchResult } from "./types.js";
import { resetThrottle, throttle } from "./providers.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const UNIPROT_JSON = JSON.stringify({
  results: [
    {
      primaryAccession: "P12345",
      uniProtkbId: "EXMP_HUMAN",
      proteinDescription: { recommendedName: { fullName: { value: "Example protein" } } },
      organism: { scientificName: "Homo sapiens" },
    },
  ],
});

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (_input: RequestInfo | URL) => new Response(UNIPROT_JSON, { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

let auditDir = "";

beforeEach(() => {
  resetThrottle();
  // Isolate egress audit writes: never touch the real ~/.pi-science config root.
  auditDir = mkdtempSync(join(tmpdir(), "pi-lit-audit-"));
  process.env.PI_SCIENCE_HOME = auditDir;
});

afterEach(() => {
  delete process.env.PI_SCIENCE_HOME;
  if (auditDir) rmSync(auditDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("LiteratureService.search — query handling", () => {
  it.each(["ACGTACGTACGTACGT", "MYKGHCFWYTPVQN", "CC(=O)O", "patient id: 123456"])("retrieves query text without approval: %s", async (query) => {
    const fetchMock = stubFetch();
    const outcome = await new LiteratureService().search(query, { providers: ["uniprot"] });
    expect(outcome.failures).toEqual([]);
    expect(outcome.results[0]?.records[0]?.id).toBe("P12345");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(encodeURIComponent(query));
  });
});

describe("LiteratureService.search — caching, dedup, failure isolation", () => {
  it("serves a repeated query from cache without hitting the network", async () => {
    const fetchMock = stubFetch();
    const service = new LiteratureService();
    await service.search("perovskite", { providers: ["uniprot"] });
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await service.search("perovskite", { providers: ["uniprot"] });
    expect(second.results[0]?.cached).toBe(true);
    expect(second.results[0]?.records).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("deduplicates records with the same DOI across providers", async () => {
    const pubmedSearch = JSON.stringify({ esearchresult: { idlist: ["1"] } });
    const pubmedSummary = JSON.stringify({
      result: { uids: ["1"], "1": { uid: "1", title: "Same paper", pubdate: "2024", authors: [], source: "J", articleids: [{ idtype: "doi", value: "10.1000/same" }] } },
    });
    const arxivXml = `<?xml version="1.0"?><feed><entry><id>http://arxiv.org/abs/2301.01234</id><title>Same paper</title><published>2024-01-01T00:00:00Z</published></entry></feed>`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.toString() : String(input);
      if (url.includes("esearch.fcgi")) return new Response(pubmedSearch, { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("esummary.fcgi")) return new Response(pubmedSummary, { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("export.arxiv.org")) return new Response(arxivXml, { status: 200, headers: { "content-type": "application/atom+xml" } });
      return new Response(UNIPROT_JSON, { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new LiteratureService();
    const outcome = await service.search("same paper", { providers: ["pubmed", "arxiv"] });
    const allRecords = outcome.results.flatMap((result) => result.records);
    expect(allRecords.filter((record) => record.doi === "10.1000/same")).toHaveLength(1);
  });

  it("deduplicates by DOI first, then provider:id (pure-function coverage)", () => {
    const base = { query: "x", hitCount: 1, truncated: false, retrievedAt: "", responseHash: "a", cached: false };
    const pubmed: LiteratureSearchResult = {
      ...base,
      provider: "pubmed",
      records: [
        { id: "1", provider: "pubmed", title: "Same paper", doi: "10.1000/same", url: "https://pubmed.ncbi.nlm.nih.gov/1/" },
        { id: "2", provider: "pubmed", title: "Different paper", doi: "10.1000/other", url: "https://pubmed.ncbi.nlm.nih.gov/2/" },
      ],
    };
    const arxiv: LiteratureSearchResult = {
      ...base,
      provider: "arxiv",
      records: [{ id: "2301.01234", provider: "arxiv", title: "Same paper", doi: "10.1000/same", url: "https://arxiv.org/abs/2301.01234" }],
    };
    const merged = deduplicate([pubmed, arxiv]);
    const all = merged.flatMap((result) => result.records);
    expect(all.filter((record) => record.doi === "10.1000/same")).toHaveLength(1);
    expect(all).toHaveLength(2);
  });

  it("keeps sibling provider results when one provider fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.toString() : String(input);
      if (url.includes("export.arxiv.org")) return new Response("boom", { status: 500 });
      return new Response(UNIPROT_JSON, { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new LiteratureService();
    const outcome = await service.search("anything", { providers: ["uniprot", "arxiv"] });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.provider).toBe("uniprot");
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.provider).toBe("arxiv");
  });

  it("records provider searches in the egress audit", async () => {
    stubFetch();
    const service = new LiteratureService();
    await service.search("perovskite", { providers: ["uniprot"] });
    const lines = readFileSync(join(auditDir, "egress-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { connector_type: string; connector_id: string; approved: boolean; note?: string });
    const search = lines.find((entry) => entry.note === "provider_search");
    expect(search).toMatchObject({ connector_type: "literature", connector_id: "uniprot", approved: false });
    expect(lines).toHaveLength(1);
  });

  it("throws for an empty or oversized query", async () => {
    const service = new LiteratureService({ maxQueryLength: 10 });
    await expect(service.search("   ")).rejects.toThrow("query is required");
    await expect(service.search("0123456789X")).rejects.toThrow("exceeds 10 characters");
  });
});

describe("throttle", () => {
  it("waits the minimum interval between consecutive calls to the same provider", async () => {
    vi.useFakeTimers();
    try {
      resetThrottle();
      await throttle("pubmed", 350);
      let done = false;
      void throttle("pubmed", 350).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(349);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
