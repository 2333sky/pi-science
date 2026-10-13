import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

const root = `/workspace/${encodeURIComponent(VISUAL_CWD)}`;

test("execution history scopes, paginates, and links timeline details @accessibility", async ({ page }, testInfo) => {
  test.skip(!["desktop-light", "mobile"].includes(testInfo.project.name), "Desktop and narrow-screen coverage");
  const records = Array.from({ length: 125 }, (_, index) => ({
    schema_version: 1, execution_id: `exec-${index}`, kind: "tool", surface: "pi", status: index === 1 ? "failed" : "succeeded",
    workspace_id: VISUAL_CWD, producer: "fixture-observer",
    created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    started_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    ended_at: new Date(Date.UTC(2026, 0, 1, 0, index, 90)).toISOString(),
    correlation: index % 3 === 0 ? {} : { session_id: index % 3 === 1 ? VISUAL_SESSION : "other-session" },
    request: { tool: `analysis-${index}` }, result: index === 1 ? { error: "Recorded failure" } : { output_preview: "Recorded tool output" },
    runtime: { model: "fixture" }, files: { read: [], written: [] }, artifacts: [],
  })).reverse();
  await page.route("**/api/executions?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const scoped = records.filter((run) => !params.get("session_id") || run.correlation.session_id === params.get("session_id"));
    const filtered = scoped.filter((run) => !params.get("search") || run.request.tool.includes(params.get("search")!));
    const offset = Number(params.get("offset") ?? 0);
    await route.fulfill({ json: { executions: filtered.slice(offset, offset + 50), total: scoped.length, filtered_total: filtered.length, offset, limit: 50 } });
  });
  await page.route("**/api/executions/*/logs?*", (route) => route.fulfill({ json: { stdout: "Recorded tool output", stderr: "", source: "preview", complete: false } }));
  await page.goto(`${root}/runs?session_id=${VISUAL_SESSION}`);
  await expect(page.getByLabel("Execution scope")).toHaveValue("session");
  await expect(page.getByRole("button", { name: /analysis-124/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /analysis-123/ })).toHaveCount(0);
  await page.getByLabel("Execution scope").selectOption("workspace");
  await expect(page.getByRole("button", { name: /analysis-123/ })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: /analysis-74\b/ })).toBeVisible();
  await page.getByLabel("Search executions").fill("analysis-0");
  await expect(page.getByRole("button", { name: /analysis-0\b/ })).toBeVisible();
  await page.getByLabel("Browse executions").selectOption("timeline");
  await page.getByRole("button", { name: /analysis-0/ }).click();
  await expect(page.getByRole("button", { name: "Ask AI to attempt reproduction" })).toBeVisible();
  await page.getByRole("tab", { name: "Output", exact: true }).click();
  await expect(page.getByText("Recorded tool output", { exact: true })).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Back to executions" }).click();
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  // Let the responsive detail-pane transition settle before measuring contrast.
  await page.waitForTimeout(300);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual([]);
});
