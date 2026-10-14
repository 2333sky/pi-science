import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchLiterature } from "./literature-search.js";
import { resetThrottle } from "../literature/providers.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));

let auditDir: string;
beforeEach(async () => {
  auditDir = await mkdtemp(join(tmpdir(), "literature-cli-"));
  vi.stubEnv("PI_SCIENCE_HOME", auditDir);
  resetThrottle();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(auditDir, { recursive: true, force: true });
});

describe("guarded literature CLI", () => {
  it.each(["ACGTACGTACGTACGT", "patient id: 123456", "CC(=O)O"])("blocks sensitive input before egress: %s", async (query) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await searchLiterature({ query })).toMatchObject({ blocked: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks configured private project terms", async () => {
    vi.stubEnv("PI_SCIENCE_SENSITIVE_TERMS", "private-project");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await searchLiterature({ query: "private-project results" })).toMatchObject({ blocked: true, categories: ["custom"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed requests, unsupported providers and approval bypasses before egress", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const input of [null, [], {}, { query: " " }, { query: "x", providers: [] }, { query: "x", providers: ["crossref"] }, { query: "x", approvedToken: "forged" }, { query: "x", approved: true }]) {
      await expect(searchLiterature(input)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retrieves every default provider including scientific records and audits actual requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes("esearch")) body = { esearchresult: { idlist: ["123"] } };
      else if (url.includes("esummary")) body = { result: { "123": { uid: "123", title: "Insulin" } } };
      else if (url.includes("/cids/")) body = { IdentifierList: { CID: [2244] } };
      else if (url.includes("/property/")) body = { PropertyTable: { Properties: [{ CID: 2244, IUPACName: "aspirin" }] } };
      else if (url.includes("uniprot")) body = { results: [{ primaryAccession: "P01308" }] };
      else if (url.includes("arxiv")) return new Response('<feed><entry><id>https://arxiv.org/abs/2301.01234</id><title>Insulin</title></entry></feed>');
      return new Response(JSON.stringify(body));
    }));
    const result = await searchLiterature({ query: "insulin" });
    expect(result.blocked).toBe(false);
    if (result.blocked) throw new Error("unexpected block");
    expect(result.failures).toEqual([]);
    expect(result.results.map((r) => r.provider).sort()).toEqual(["arxiv", "genbank", "pubchem", "pubmed", "uniprot"]);
    for (const provider of result.results) expect(provider.records).toHaveLength(1);
    const audit = await readFile(join(auditDir, "egress-audit.jsonl"), "utf8");
    const entries = audit.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toHaveLength(8);
    expect(new Set(entries.map((entry) => entry.connector_id))).toEqual(new Set(["pubmed", "genbank", "arxiv", "pubchem", "uniprot"]));
    expect(audit).not.toContain("insulin");
  });
});
