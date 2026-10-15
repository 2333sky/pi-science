/** Compact question mode geometry and draft lifecycle in the production app. */
import type { Page } from "@playwright/test";
import { test, expect, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD, VISUAL_SESSION } from "./fixtures/data.mjs";

type PreviewWindow = Window & { questionSources: EventSource[] };
const callId = "compact-question-tool";
const requestId = "compact-question-request";
const questions = [
  { question: "Which analysis should we run next?", header: "Analysis", multiSelect: false, options: [
    { label: "Differential expression (Recommended)", description: "Compare treatment and control before pathway enrichment.", preview: "### Analysis plan\n" + "\n- Normalize expression and compare treatment groups.\n".repeat(30) },
    { label: "Metabolic network modelling", description: "Explore flux changes in the reaction network." },
    { label: "Review data quality first", description: "Inspect missing values and batch effects." },
  ] },
  { question: "Which outputs do you need?", header: "Outputs", multiSelect: true, options: [{ label: "Figures", description: "Publication-ready plots." }, { label: "Tables", description: "Reusable result tables." }] },
];
async function emit(page: Page, events: Array<Record<string, unknown>>) {
  await page.evaluate(({ events, session }) => {
    const source = (window as unknown as PreviewWindow).questionSources.find((item) => item.url.includes(`/sessions/${session}/events`));
    if (!source) throw new Error("Session event stream missing");
    for (const event of events) source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ sessionId: session, ...event }) }));
  }, { events, session: VISUAL_SESSION });
}
async function openQuestion(page: Page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    (window as unknown as PreviewWindow).questionSources = [];
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) { super(url, options); (window as unknown as PreviewWindow).questionSources.push(this); }
    };
  });
  await page.goto(workspaceRoute(VISUAL_CWD, `/session/${VISUAL_SESSION}`));
  await expect(page.getByRole("heading", { name: "Shikimate pathway analysis" })).toBeVisible();
  await page.getByRole("combobox", { name: "Message", exact: true }).fill("Keep my unsent research question");
  await emit(page, [{ type: "questionnaire.asked", toolCallId: callId, questions }, { type: "interaction.requested", requestId, toolCallId: callId, questionnaire: true, method: "input", title: "Analysis" }]);
  await expect(page.getByRole("region", { name: "Answer a few questions" })).toBeVisible();
}

test("question mode stays compact, details do not resize it, and collapse preserves drafts", async ({ page }, testInfo) => {
  await openQuestion(page);
  const form = page.getByRole("region", { name: "Answer a few questions" });
  const input = page.getByRole("combobox", { name: "Message", exact: true, includeHidden: true });
  await expect(input).toBeHidden();
  const first = await form.boundingBox();
  expect(first).not.toBeNull();
  if (page.viewportSize()!.width >= 1024) expect(first!.height).toBeLessThanOrEqual(280);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("radio", { name: /Differential expression/ }).click();
  await expect(page.getByRole("heading", { name: questions[0]!.question })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("question-compact.png") });
  await page.getByRole("button", { name: /Preview Differential expression/ }).click();
  const details = page.getByRole("dialog", { name: /Preview Differential expression/ });
  await expect(details).toBeVisible();
  const preview = await details.boundingBox();
  const viewport = page.viewportSize()!;
  expect(preview!.x).toBeGreaterThanOrEqual(0);
  expect(preview!.x + preview!.width).toBeLessThanOrEqual(viewport.width);
  expect(preview!.y).toBeGreaterThanOrEqual(0);
  expect(preview!.y + preview!.height).toBeLessThanOrEqual(viewport.height);
  expect((await form.boundingBox())!.height).toBe(first!.height);
  await page.screenshot({ path: testInfo.outputPath("question-details.png") });
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(page.getByRole("button", { name: /Preview Differential expression/ })).toBeFocused();
  await expect(form).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form).toBeHidden();
  await expect(page.getByRole("button", { name: /Continue answering/ })).toContainText("1 of 2 answered");
  await expect(input).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("question-collapsed.png") });
  await page.getByRole("button", { name: /Continue answering/ }).click();
  await expect(page.getByRole("radio", { name: /Differential expression/ })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await emit(page, [{ type: "questionnaire.finished", toolCallId: callId }]);
  await expect(input).toBeVisible();
  await expect(input).toHaveText("Keep my unsent research question");
  await expect(input).toBeFocused();
});

test("long question content scrolls above visible actions in a short viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 768, height: 480 });
  await openQuestion(page);
  await page.getByRole("button", { name: /Type something/ }).click();
  await page.getByRole("textbox", { name: "Your answer" }).fill("A custom analysis with a longer explanation");
  await page.getByRole("button", { name: "Notes for this question" }).click();
  const form = page.getByRole("region", { name: "Answer a few questions" });
  const box = await form.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(240);
  expect(box!.y).toBeGreaterThanOrEqual(44);
  expect(box!.y + box!.height).toBeLessThanOrEqual(480);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("checkbox", { name: "Tables", exact: true }).click();
  await expect(page.getByRole("button", { name: "Submit answers" })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("question-short-viewport.png") });
});

test("review regressions preserve saved choices and respect the user's focus", async ({ page }) => {
  await openQuestion(page);
  const heading = page.getByRole("heading", { name: questions[0]!.question });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("radio", { name: /Differential expression/ }).focus();
    await page.keyboard.press("Control+Enter");
    await expect(page.getByRole("alert")).toContainText("Please answer question 1");
    await expect(heading).toBeFocused();
  }
  await page.getByRole("radio", { name: /Differential expression/ }).click();
  await page.getByRole("button", { name: /Type something/ }).click();
  await page.getByRole("textbox", { name: "Your answer" }).fill("   ");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("checkbox", { name: "Tables", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("radio", { name: /Differential expression/ })).toBeChecked();
  // Model an independently focused inspector editor, outside the question seat.
  await page.evaluate(() => {
    const editor = document.createElement("textarea");
    editor.setAttribute("aria-label", "Independent file editor");
    document.body.append(editor);
    editor.focus();
  });
  const other = page.getByRole("textbox", { name: "Independent file editor" });
  await expect(other).toBeFocused();
  await emit(page, [{ type: "questionnaire.finished", toolCallId: callId }]);
  await expect(page.getByRole("region", { name: "Answer a few questions" })).toHaveCount(0);
  await expect(other).toBeFocused();
  const composer = page.getByRole("combobox", { name: "Message", exact: true });
  await expect(composer).toBeVisible();
  await expect(composer).toHaveText("Keep my unsent research question");
});
