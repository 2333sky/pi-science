import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../client/query-client";
import { skillsMutations } from "./skills-mutations";

/** Workspace writes invalidate both the blank-composer catalog and active-session catalogs. */
const workspaceCatalogueKey = ["composer-commands", "/tmp/lab", null];
const sessionCatalogueKey = ["composer-commands", "/tmp/lab", "session-1"];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("skill writes refresh the command catalogue", () => {
  it("marks the workspace catalogue stale after a successful write", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ok: true, skill: { name: "review" } })));
    queryClient.setQueryData(workspaceCatalogueKey, [{ name: "skill:review", description: "Review files", group: "skill" }]);
    queryClient.setQueryData(sessionCatalogueKey, [{ name: "skill:review", description: "Review files", group: "skill" }]);
    await skillsMutations.create("/tmp/lab", { name: "review", description: "Review files" });
    expect(queryClient.getQueryState(workspaceCatalogueKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(sessionCatalogueKey)?.isInvalidated).toBe(true);
  });

  it("leaves the catalogue alone when the write fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "skills are read-only" }, 500)));
    queryClient.setQueryData(workspaceCatalogueKey, [{ name: "skill:review", description: "Review files", group: "skill" }]);
    await expect(skillsMutations.create("/tmp/lab", { name: "review", description: "Review files" })).rejects.toThrow("skills are read-only");
    expect(queryClient.getQueryState(workspaceCatalogueKey)?.isInvalidated).toBe(false);
  });
});

