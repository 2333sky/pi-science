/**
 * Regression test for the "refresh during the lazy session-create round trip"
 * loss: send a prompt on a blank workspace landing, reload while the browser is
 * still waiting for `POST /api/sessions`, and assert the prompt survives, is
 * delivered exactly once, and does not leave an orphan empty session.
 *
 * The create request is forwarded to the real server and only its response is
 * held in the browser. That is the window that used to lose the message: the
 * session exists on the server, but the page has not learned its id yet. A
 * browser-side delay that never forwards the request does not exercise the
 * idempotency key and must not be used here.
 */
import { chromium } from "playwright-core";
import { resolveBrowserExecutable } from "./browser-executable.mjs";

const frontend = process.env.PI_SCIENCE_FRONTEND_URL || "http://127.0.0.1:5173";
const backend = process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787";
const chromePath = await resolveBrowserExecutable();
const internalToken = process.env.PI_SCIENCE_INTERNAL_TOKEN;
const TEXT = `REPLAY_AFTER_REFRESH_${Date.now()}`;

function authenticatedInit(init = {}) {
  const headers = new Headers(init.headers);
  if (internalToken) headers.set("x-pi-science-internal-token", internalToken);
  return { ...init, headers };
}

async function api(path, init) {
  const response = await fetch(`${backend}${path}`, authenticatedInit(init));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  const runtime = response.headers.get("x-pi-science-runtime");
  if (runtime && runtime !== "node-control-plane") {
    throw new Error(`${path}: expected node-control-plane runtime, got ${runtime}`);
  }
  return response.json();
}

async function waitFor(probe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function sessionIdFromUrl(url) {
  const match = /\/session\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

const workspace = process.env.PI_SCIENCE_REPLAY_WORKSPACE
  ?? (await api("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `replay-uat-${Date.now()}` }),
  })).path;

const cwdQuery = `?cwd=${encodeURIComponent(workspace)}`;
const asList = (payload) => (Array.isArray(payload) ? payload : payload?.sessions ?? []);
const failure = (message) => {
  throw new Error(message);
};
const beforeIds = new Set(asList(await api(`/api/sessions${cwdQuery}`)).map((session) => session.id));

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
const pageErrors = [];
const consoleErrors = [];
const promptPosts = [];
const createPosts = [];
const promptResponses = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("request", (request) => {
  const url = new URL(request.url());
  if (request.method() === "POST" && /\/api\/sessions\/[^/]+\/prompts?$/.test(url.pathname)) promptPosts.push(request.postData() ?? "");
});
page.on("response", (response) => {
  const url = new URL(response.url());
  if (response.request().method() === "POST" && url.pathname === "/api/sessions") promptResponses.push(response.status());
});

let releaseHeldCreate;
const heldCreateReleased = new Promise((resolve) => { releaseHeldCreate = resolve; });
let heldCreateResponse = null;

try {
  // The first create is forwarded for real; the server commits the session and
  // only the browser-visible response is held until after the reload. Every
  // later create (the replay) passes straight through.
  await page.route("**/api/sessions", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "POST" || url.pathname !== "/api/sessions") return route.continue();
    createPosts.push(route.request().postData() ?? "");
    if (createPosts.length !== 1) return route.continue();
    const response = await route.fetch();
    heldCreateResponse = response;
    await heldCreateReleased;
    // The document that asked is gone by now; releasing the held route is only
    // cleanup, so a closed page must not fail the run.
    await route.fulfill({ response }).catch(() => undefined);
  });

  await page.goto(`${frontend}/workspace/${encodeURIComponent(workspace)}`, { waitUntil: "domcontentloaded" });
  // Let the workspace session list settle first: on a workspace with history the
  // app may auto-open the newest session a moment after load. Then pin an
  // explicit blank landing, whose history state also survives the reload below
  // and keeps the app from auto-navigating away after it.
  await page.waitForTimeout(3_000);
  await page.getByTitle("New conversation").click();
  await page.waitForFunction(() => !/\/session\//.test(window.location.pathname), undefined, { timeout: 20_000 });
  if (sessionIdFromUrl(page.url())) failure(`Could not reach the blank landing: ${page.url()}`);
  const composer = page.getByPlaceholder(/Enter a research question|Ask anything/);
  await composer.waitFor({ timeout: 20_000 });
  await composer.fill(TEXT);
  await page.getByRole("button", { name: "Send message" }).click();

  // The real window: wait until the server has committed the session while the
  // browser still has not received the create response.
  const committed = await waitFor(async () => {
    // Both must hold: the server committed the session and Playwright already holds
    // its response, so the browser provably never received the id.
    if (!heldCreateResponse) return null;
    const fresh = asList(await api(`/api/sessions${cwdQuery}`)).filter((session) => !beforeIds.has(session.id));
    return fresh.length > 0 ? fresh : null;
  }, 60_000, "the session create never reached the server before the reload");
  if (committed.length !== 1) failure(`Expected the in-flight create to commit one session, got ${committed.length}`);
  if (createPosts.length !== 1) failure(`Expected one create before the reload, got ${createPosts.length}`);
  if (sessionIdFromUrl(page.url())) failure(`Session was created before the reload window: ${page.url()}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  releaseHeldCreate();

  // Before the fix the prompt was gone at this point and this wait timed out.
  const replayed = page.getByText(TEXT, { exact: true }).first();
  await replayed.waitFor({ timeout: 90_000 });
  console.log("INFO prompt is visible after the refresh");

  // The page must open the session the server already committed, not a new one.
  const opened = await waitFor(() => sessionIdFromUrl(page.url()), 60_000, `the replayed prompt never opened its conversation (url ${page.url()})`);
  if (opened !== committed[0].id) failure(`The page opened session ${opened}, not the replayed session ${committed[0].id}`);

  // The prompt must be persisted exactly once, in that same session.
  const messages = await waitFor(async () => {
    const payload = await api(`/api/sessions/${encodeURIComponent(committed[0].id)}/messages${cwdQuery}`);
    const persisted = (payload.messages ?? []).filter((message) => message.role === "user");
    return persisted.length > 0 ? persisted : null;
  }, 30_000, "the replayed prompt was not persisted");
  if (messages.length !== 1) failure(`Expected exactly one user message, got ${messages.length}`);
  if ((messages[0]?.content?.[0]?.text ?? "") !== TEXT) failure("The persisted prompt text does not match what was typed");
  if (promptPosts.length !== 1) failure(`Expected exactly one prompt POST, got ${promptPosts.length}`);

  // A replay that only paints the text on the landing page is not a recovery:
  // the replayed create must have adopted the session instead of creating one.
  const sessionsAfter = asList(await api(`/api/sessions${cwdQuery}`));
  const fresh = sessionsAfter.filter((session) => !beforeIds.has(session.id));
  if (fresh.length !== 1) failure(`Expected exactly one new session, got ${fresh.length}: ${fresh.map((session) => session.id).join(", ")}`);
  if (createPosts.length !== 2) failure(`Expected the replay to issue one more create, got ${createPosts.length} total`);
  const replayedKey = JSON.parse(createPosts[1]).idempotencyKey;
  const initialKey = JSON.parse(createPosts[0]).idempotencyKey;
  if (!replayedKey || replayedKey !== initialKey) failure(`The replay did not reuse the create idempotency key (${initialKey} -> ${replayedKey})`);
  if (!promptResponses.includes(200)) failure(`The replayed create did not adopt the existing session (create responses: ${promptResponses.join(",")})`);

  console.log(`PASS session=${committed[0].id} createPosts=${createPosts.length} createResponses=${promptResponses.join(",")} promptPosts=${promptPosts.length} messages=${messages.length} url=${new URL(page.url()).pathname}`);
} finally {
  releaseHeldCreate();
  await browser.close();
  if (pageErrors.length || consoleErrors.length) {
    console.log(`INFO pageErrors=${JSON.stringify(pageErrors)} consoleErrors=${JSON.stringify(consoleErrors.slice(0, 5))}`);
  }
}
