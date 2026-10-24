// Real Chromium + live server acceptance. No mocked routes or model requests.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowserExecutable } from "./browser-executable.mjs";

const frontend = process.env.PI_SCIENCE_FRONTEND_URL || "http://127.0.0.1:5173";
const backend = process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787";
const root = process.env.PI_SCIENCE_SLASH_UAT_ROOT || path.join(os.tmpdir(), "pi-science-slash-uat");
const blank = path.join(root, "blank-workspace");
const cold = path.join(root, "cold-workspace");
const sessionId = "slash-browser-acceptance";
await mkdir(path.join(blank, ".pi-science"), { recursive: true });
await mkdir(path.join(cold, ".pi-science", "sessions"), { recursive: true });
// Retain fixed workspace fixtures: the live app registers them in its project list.
await writeFile(path.join(cold, ".pi-science", "sessions", `${sessionId}.jsonl`), [
  { type: "session", version: 3, id: sessionId, cwd: cold, timestamp: "2026-10-21T06:00:00.000Z" },
  { type: "message", id: "slash-user", parentId: null, timestamp: "2026-10-21T06:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Slash browser acceptance fixture" }] } },
  { type: "message", id: "slash-assistant", parentId: "slash-user", timestamp: "2026-10-21T06:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Ready for command completion testing." }] } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

const headers = process.env.PI_SCIENCE_INTERNAL_TOKEN ? { "x-pi-science-internal-token": process.env.PI_SCIENCE_INTERNAL_TOKEN } : {};
const health = async () => {
  const response = await fetch(`${backend}/api/health`, { headers });
  assert.equal(response.status, 200);
  return response.json();
};
assert.equal((await health()).active_agent_workers, 0, "Run against an idle, isolated test server");
const browser = await chromium.launch({ executablePath: await resolveBrowserExecutable(), headless: true });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const commands = [];
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  if (new URL(response.url()).origin === new URL(frontend).origin && response.url().includes("/commands?")) commands.push({ url: response.url(), status: response.status() });
});
await context.tracing.start({ screenshots: true, snapshots: true });
async function checkComposer(label) {
  const composer = page.getByRole("combobox");
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.fill("");
  await composer.pressSequentially("/");
  const literature = page.getByRole("option").filter({ hasText: "/skill:literature-review" });
  await literature.waitFor({ timeout: 20_000 });
  const labels = await page.getByRole("option").allTextContents();
  assert(labels.some((label) => label.startsWith("/compact")));
  assert(labels.some((label) => label.startsWith("/export")));
  const skills = labels.filter((label) => label.startsWith("/skill:"));
  assert(skills.length >= 14, `Expected packaged skill list, got ${skills.length}`);
  await page.screenshot({ path: path.join(root, `${label}-list.png`), fullPage: true });
  await composer.fill("/skill:lit");
  await literature.waitFor();
  assert.equal(await page.getByRole("option").count(), 1);
  await composer.press("Tab");
  assert.equal(await composer.inputValue(), "/skill:literature-review");
  assert.equal(await page.getByRole("listbox").count(), 0);
  await composer.fill("/skill:pdf");
  await page.getByRole("option").filter({ hasText: "/skill:pdf-explore" }).click();
  assert.equal(await composer.inputValue(), "/skill:pdf-explore");
  await page.mouse.move(1400, 20);
  await composer.fill("");
  await composer.pressSequentially("/");
  await page.getByRole("option", { selected: true }).filter({ hasText: "/compact" }).waitFor();
  await composer.press("ArrowDown");
  await page.getByRole("option", { selected: true }).filter({ hasText: "/export" }).waitFor();
  await composer.press("Escape");
  assert.equal(await page.getByRole("listbox").count(), 0);
  await composer.fill("");
  checks.push({ label, skillCount: skills.length, passed: ["list", "filter", "Tab", "mouse selection", "ArrowDown", "Escape"] });
}
try {
  await page.goto(`${frontend}/workspace/${encodeURIComponent(blank)}`, { waitUntil: "networkidle" });
  assert(!page.url().includes("/session/"));
  await checkComposer("blank");
  await page.goto(`${frontend}/workspace/${encodeURIComponent(cold)}/session/${sessionId}`, { waitUntil: "networkidle" });
  await checkComposer("cold-session");
  await page.reload({ waitUntil: "networkidle" });
  await checkComposer("reloaded-session");
  assert.equal((await health()).active_agent_workers, 0, "Completion must not start a worker");
  assert(commands.some((request) => request.url.includes("/api/composer/commands")));
  assert(commands.some((request) => request.url.includes(`/api/sessions/${sessionId}/commands`)));
  assert(commands.every((request) => request.status === 200), JSON.stringify(commands));
  assert.deepEqual(errors, []);
  const report = { checks, commands, pageErrors: errors, activeWorkers: 0 };
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(root, "failure.png"), fullPage: true });
  console.error("Page:", (await page.locator("body").innerText()).slice(-2500));
  throw error;
} finally {
  await context.tracing.stop({ path: path.join(root, "trace.zip") });
  await browser.close();
}
