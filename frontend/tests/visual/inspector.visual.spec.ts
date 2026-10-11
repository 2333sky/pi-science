/** Inspector visual baselines: opening a workspace file from the sidebar and
 *  the markdown preview on the right side. */

import { expect, screenshot, test, waitForConversationSettled, workspaceRoute } from "./fixtures/app.fixture";
import { VISUAL_CWD } from "./fixtures/data.mjs";

async function openSidebarFile(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo) {
  // The mobile project renders the collapsed rail without the file browser,
  // so the sidebar file-open flow is exercised on desktop/tablet/wide only.
  test.skip(testInfo.project.name === "mobile", "mobile rail hides the file browser");
  await page.goto(workspaceRoute(VISUAL_CWD));
  // The workspace root auto-navigates into the most recent session; the
  // thread must be fully settled before the sidebar interaction so the
  // captured baseline never shows a half-loaded conversation.
  await waitForConversationSettled(page);
  // Show the Context Panel's Files tab, then open the fixture file from its
  // embedded tree. Scoping to the panel element guarantees the click lands on
  // the real file browser row, not on the conversation's artifact strip
  // (which would render report.md without the panel being involved).
  const sidebar = page.locator("#workspace-context-panel");
  // The Files entry is a Context Panel tab, not a navigation button, and the
  // embedded tree replaced the old collapsible section header.
  await sidebar.getByRole("tab", { name: "Files", exact: true }).click();
  await sidebar.getByRole("button", { name: "analysis", exact: true }).click();
  const fileRow = sidebar.getByRole("button", { name: "report.md" });
  await expect(fileRow).toBeVisible();
  await fileRow.click();
}

test("sidebar file opens the inspector with a markdown preview", async ({ page }, testInfo) => {
  await openSidebarFile(page, testInfo);
  await expect(page.locator('[data-variant="file"]')).toBeVisible();
  await expect(page.getByText("Fold change report")).toBeVisible();
  // The composer stays usable with the inspector open — the same state the
  // former separate file-preview / with-composer tests both captured. They
  // were fully redundant (identical layout and assertions on the settled
  // thread), so they are merged here instead of keeping fake coverage.
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();
  await screenshot(page, "inspector-file-preview.png");
});

import { previewFiles } from "./fixtures/preview-files";

test("focus preserves the document and returns to the expanded workspace", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop") && testInfo.project.name !== "wide", "focus is a desktop action");
  await openSidebarFile(page, testInfo);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Expand workspace", exact: true }).click();
  await page.getByRole("button", { name: "Focus file", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "report.md", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Reset zoom to 100%" })).toHaveText("110%");
  await screenshot(page, "inspector-document-focus.png");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Restore split layout" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Focus file" })).toBeFocused();
});

test("representative ordinary and scientific previews share responsive chrome", async ({ page }, testInfo) => {
  test.skip(!["desktop-light", "desktop-dark", "tablet"].includes(testInfo.project.name), "representative themes and narrow preview");
  await page.route("**/api/files**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/files" && !url.searchParams.get("subdir")) {
      const response = await route.fetch();
      const entries = await response.json();
      await route.fulfill({ response, json: [...entries, ...Object.keys(previewFiles).map((name) => ({ path: name, name, isDir: false, size: 512, modified: 1755268800000 }))] });
      return;
    }
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/files\/(serve\/)?/, ""));
    const file = previewFiles[path];
    if (!file) { await route.continue(); return; }
    if (url.pathname.includes("/serve/")) {
      await route.fulfill({ contentType: file.mime ?? "application/octet-stream", body: file.data });
    } else {
      await route.fulfill({ json: { encoding: typeof file.data === "string" ? "utf8" : "base64", data: typeof file.data === "string" ? file.data : file.data.toString("base64") } });
    }
  });
  await page.goto(workspaceRoute(VISUAL_CWD));
  await waitForConversationSettled(page);
  const sidebar = page.locator("#workspace-context-panel");
  await sidebar.getByRole("tab", { name: "Files", exact: true }).click();
  for (const name of Object.keys(previewFiles)) {
    await sidebar.getByRole("button", { name, exact: true }).click();
    const panel = page.getByRole("tabpanel").filter({ has: page.locator('[data-variant="file"]') });
    await expect(panel).toBeVisible();
    if (name === "sample.pdb") await expect(panel.getByText(/\d+ atoms/)).toBeVisible();
    else if (name === "sample.stl") await expect(panel.getByText(/4 triangles/)).toBeVisible();
    else if (name === "sample.svg") await expect(panel.getByText("600 × 400 px")).toBeVisible();
    else if (name === "sample.fits") await expect(panel.getByText(/sample.fits · 32×32/)).toBeVisible();
    else if (name === "sample.bed") {
      await expect(panel.getByText(/2 features/)).toBeVisible();
      const genome = panel.locator("svg").last();
      await expect.poll(async () => genome.evaluate((svg) => Math.abs(svg.getBoundingClientRect().width - svg.closest('[role="tabpanel"]')!.getBoundingClientRect().width))).toBeLessThan(2);
    }
    else if (name === "sample.csv") await expect(panel.getByRole("cell", { name: "-2.5e-3" })).toBeVisible();
    else await expect(panel.getByText("# Fit the measurements")).toBeVisible();
    expect(await panel.locator('[style*="zoom"]').count()).toBe(0);
    await page.evaluate(() => document.fonts.ready);
    await expect(panel).toHaveScreenshot(`preview-${name.replace(".", "-")}.png`, { animations: "disabled" });
    if (testInfo.project.name !== "tablet" && ["sample.bed", "sample.stl", "sample.fits", "sample.pdb"].includes(name)) {
      const canvas = panel.locator("canvas, svg").last();
      await canvas.evaluate((element) => element.setAttribute("data-retained-view", "true"));
      await panel.getByRole("button", { name: "Focus file", exact: true }).click();
      const dialog = page.getByRole("dialog", { name, exact: true });
      await expect(dialog.locator('[data-retained-view="true"]')).toHaveCount(1);
      expect(await dialog.locator('[style*="zoom"]').count()).toBe(0);
      await page.keyboard.press("Escape");
      await expect(panel.locator('[data-retained-view="true"]')).toHaveCount(1);
    }
    if (testInfo.project.name === "tablet") await page.keyboard.press("Escape");
  }
});

test("mobile preview has one closable overlay without an extra focus layer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile overlay contract");
  await page.goto(workspaceRoute(VISUAL_CWD));
  await waitForConversationSettled(page);
  await page.getByRole("button", { name: /report\.md/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "Open file previews" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Focus file" })).not.toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close report.md" })).toBeVisible();
  await screenshot(page, "inspector-mobile-preview.png");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

function pdfFocusFixture() {
  const stream = "BT /F1 20 Tf 30 160 Td (PDF focus test) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

test("iframe focus supports HTML Esc and an accessible native PDF exit", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-light", "browsing-context keyboard regression");
  const files = {
    "focus.html": { mime: "text/html", data: '<!doctype html><html><body><input aria-label="Embedded input" autofocus><button onclick="document.body.dataset.clicked=1">Embedded action</button></body></html>' },
    "focus.pdf": { mime: "application/pdf", data: pdfFocusFixture() },
  };
  await page.route("**/api/files**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/files" && !url.searchParams.get("subdir")) {
      const response = await route.fetch();
      await route.fulfill({ response, json: [...await response.json(), ...Object.keys(files).map((name) => ({ path: name, name, isDir: false, size: 1024, modified: 1755268800000 }))] });
      return;
    }
    const name = url.pathname.replace(/^\/api\/files\/(serve\/)?/, "") as keyof typeof files;
    const file = files[name];
    if (!file) { await route.continue(); return; }
    if (url.pathname.includes("/serve/")) await route.fulfill({ contentType: file.mime, body: file.data });
    else await route.fulfill({ json: { encoding: "utf8", data: file.data } });
  });
  await page.goto(workspaceRoute(VISUAL_CWD));
  await waitForConversationSettled(page);
  const sidebar = page.locator("#workspace-context-panel");
  await sidebar.getByRole("tab", { name: "Files", exact: true }).click();
  await sidebar.getByRole("button", { name: "focus.html", exact: true }).click();
  await page.getByRole("button", { name: "Focus file", exact: true }).click();
  const htmlDialog = page.getByRole("dialog", { name: "focus.html", exact: true });
  const embeddedInput = htmlDialog.frameLocator("iframe").getByRole("textbox", { name: "Embedded input" });
  await embeddedInput.click();
  await expect(embeddedInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(htmlDialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Focus file", exact: true })).toBeFocused();

  await sidebar.getByRole("button", { name: "focus.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Focus file", exact: true }).click();
  const pdfDialog = page.getByRole("dialog", { name: "focus.pdf", exact: true });
  await expect(pdfDialog.getByRole("note")).toContainText("browser PDF viewer may handle Esc itself");
  // Browser-owned PDF plugin focus is not always exposed as activeElement
  // after a pointer click. Explicitly focus its containing browsing context.
  await pdfDialog.locator("iframe").focus();
  await expect.poll(() => pdfDialog.locator("iframe").evaluate((frame) => frame.ownerDocument.activeElement === frame)).toBe(true);
  // Chromium owns PDF keyboard handling; exercise the guaranteed parent exit.
  const exit = pdfDialog.getByRole("button", { name: "Exit focus", exact: true });
  await expect(exit).toBeVisible();
  await exit.click();
  await expect(pdfDialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Focus file", exact: true })).toBeFocused();
});
