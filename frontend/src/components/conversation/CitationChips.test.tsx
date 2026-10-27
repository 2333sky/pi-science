import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { extractCitations } from "../../lib/citations";
import { CitationChips } from "./CitationChips";

const text = "References\n\n1. He, K. (2016). Deep residual learning for image recognition. CVPR. 10.1038/x";

const snapshot = {
  citations: [{
    kind: "doi", id: "10.1038/x", status: "found", title: "Attention Is All You Need", authors: ["Ashish Vaswani"],
    journal: null, year: "2017", retraction: "clear", retraction_note: null, retraction_url: null,
    checked_providers: ["crossref"], error: null, status_note: null,
    bibliographic: "mismatch", bibliographic_note: "He, K. (2016). Deep residual learning for image recognition. CVPR.",
    version: "not_applicable", requested_version: null, record_version: null, verified_at: "2026-10-27T09:00:00.000Z",
  }],
};

beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { useRuntimeStore.setState({ cwd: "proj" }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows a reference entry that contradicts the record and reads it from the snapshot", async () => {
  const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CitationChips citations={extractCitations(text)} text={text} />
    </QueryClientProvider>,
  );

  expect(await screen.findByLabelText("Bibliographic mismatch")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("link").getAttribute("title")).toContain("Deep residual learning"));
  expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/citations/snapshot");
});
