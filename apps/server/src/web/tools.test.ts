import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { builtinMcpConnectors } from "../mcp/builtin-connectors.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function run(body: string, settings: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-native-web-")); roots.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify({ web_access: { provider: "exa", credential_refs: { exa: "fixture-key" }, ...settings } }));
  const foreign = join(root, "foreign"); await mkdir(foreign);
  await writeFile(join(foreign, "web-search.json"), JSON.stringify({ provider: "brave", braveApiKey: "foreign-key", ssrf: { allowRanges: ["127.0.0.0/8"] } }));
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { webTools } from ${JSON.stringify(new URL("./tools.ts", import.meta.url).href)};
    import { SettingsStore } from ${JSON.stringify(new URL("../storage/settings-store.ts", import.meta.url).href)};
    import { CredentialStore } from ${JSON.stringify(new URL("../model-resources/credential-store.ts", import.meta.url).href)};
    import { readFile } from "node:fs/promises";
    await new CredentialStore().put({ id: "fixture-key", kind: "api_key", backend: "managed", secret: "fixture-key" });
    const calls = [];
    const requests = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input)); calls.push(url.href);
      if (url.hostname === "api.deepseek.com") {
        requests.push({ path: url.pathname, body: JSON.parse(init.body), authorization: init.headers.Authorization });
        return Response.json(url.pathname.endsWith("/search") ? { results: [{ title: "DeepSeek research", url: "https://93.184.216.34/page", snippet: "Short", summary: "Detailed evidence" }] } : { title: "DeepSeek page", content: "# Markdown evidence" });
      }
      if (url.hostname === "api.exa.ai") return Response.json({ results: [{ title: "Research fixture", url: "https://93.184.216.34/page", text: "Scientific evidence fixture" }] });
      if (url.hostname !== "93.184.216.34") throw new Error("Unexpected outbound request: " + url);
      if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
      if (url.pathname === "/oversized") return new Response("too large", { headers: { "content-length": "999999999", "content-type": "text/plain" } });
      if (url.pathname === "/slow") return new Promise((resolve, reject) => {
        if (init.signal?.aborted) reject(init.signal.reason);
        else init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return new Response("Scientific evidence fixture. " + "Page content. ".repeat(100), { headers: { "content-type": "text/plain" } });
    };
    const tools = await webTools();
    const call = (name, params, signal) => tools.find((tool) => tool.name === name).execute("call", params, () => {}, {}, {}, { abortSignal: signal });
    const text = (value) => value.content.filter((part) => part.type === "text").map((part) => part.text).join("\\n");
    ${body}
  `], { env: { ...process.env, PI_SCIENCE_HOME: root, PI_CODING_AGENT_DIR: foreign }, timeout: 30_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout.split("__WEB_RESULT__").at(-1)!);
}

it("replaces the Web Access MCP connector with two native tools and real search/fetch/cache behavior", async () => {
  expect(builtinMcpConnectors().some((connector) => connector.connector_id === "mcp_builtin_web_access")).toBe(false);
  const result = await run(`
    const search = await call("web_search", { query: "scientific evidence" });
    const page = await call("web_fetch", { url: "https://93.184.216.34/page", mode: "raw" });
    const searchId = search.details.searchId;
    const cached = await call("web_fetch", { responseId: searchId, offset: 0, limit: 80 });
    const generated = JSON.parse(await readFile(process.env.PI_SCIENCE_HOME + "/web/runtime/web-search.json", "utf8"));
    console.log("__WEB_RESULT__" + JSON.stringify({ names: tools.map(t => t.name), search: text(search), page: text(page), cached: text(cached), generated, calls }));
  `);
  expect(result.names).toEqual(["web_search", "web_fetch"]);
  expect(result.search).toContain("Research fixture");
  expect(result.page).toContain("Scientific evidence fixture");
  expect(result.cached).toContain("Results for:");
  expect(result.cached).toContain("web_fetch");
  expect(result.generated).toMatchObject({ provider: "exa", ssrf: { allowRanges: [], trustEnvProxy: false }, githubClone: { enabled: false } });
  expect(result.calls.some((url: string) => url.includes("brave"))).toBe(false);
}, 35_000);

it("blocks private targets, private redirects and oversized responses, and cancels in-flight fetches", async () => {
  const result = await run(`
    const results = [];
    let localRejected = false;
    try { await call("web_fetch", { url: "file:///etc/passwd" }); } catch { localRejected = true; }
    for (const url of ["http://127.0.0.1/private", "https://93.184.216.34/redirect", "https://93.184.216.34/oversized"]) results.push(await call("web_fetch", { url, mode: "raw" }));
    const controller = new AbortController();
    const pending = call("web_fetch", { url: "https://93.184.216.34/slow", mode: "raw" }, controller.signal).catch(error => ({ isError: true }));
    setTimeout(() => controller.abort(), 100);
    results.push(await pending);
    console.log("__WEB_RESULT__" + JSON.stringify({ errors: results.map(value => value.isError === true), localRejected, calls }));
  `);
  expect(result.errors).toEqual([true, true, true, true]);
  expect(result.localRejected).toBe(true);
  expect(result.calls.some((url: string) => url.includes("127.0.0.1"))).toBe(false);
}, 35_000);

it("enforces settings changes on already registered tools and hides disabled tools on reopen", async () => {
  const result = await run(`
    await new SettingsStore().update(config => { config.web_access = { search_enabled: false, fetch_enabled: false }; });
    const errors = [];
    for (const name of ["web_search", "web_fetch"]) {
      try { await call(name, name === "web_search" ? { query: "test" } : { url: "https://example.com" }); }
      catch (error) { errors.push(error.message); }
    }
    console.log("__WEB_RESULT__" + JSON.stringify({ names: (await webTools()).map(t => t.name), errors, calls }));
  `);
  expect(result.names).toEqual([]);
  expect(result.errors).toHaveLength(2);
  expect(result.errors.every((error: string) => error.includes("disabled"))).toBe(true);
  expect(result.calls).toEqual([]);
});

it("routes both tools to DeepSeek and keeps cached pages accessible after switching providers", async () => {
  const result = await run(`
    const search = await call("web_search", { query: "science", numResults: 2 });
    const page = await call("web_fetch", { url: "https://93.184.216.34/page" });
    await new SettingsStore().update(config => { config.web_access.provider = "exa"; });
    const cached = await call("web_fetch", { responseId: page.details.responseId, offset: 0, limit: 200 });
    console.log("__WEB_RESULT__" + JSON.stringify({ search: text(search), page: text(page), cached: text(cached), requests, calls }));
  `, { provider: "deepseek", credential_refs: { deepseek: "fixture-key" } });
  expect(result.search).toContain("DeepSeek research");
  expect(result.page).toContain("# Markdown evidence");
  expect(result.cached).toContain("# Markdown evidence");
  expect(result.requests).toEqual([
    { path: "/v1/tools/search", body: { query: "science", count: 2, need_content: false }, authorization: "Bearer fixture-key" },
    { path: "/v1/tools/fetch", body: { url: "https://93.184.216.34/page" }, authorization: "Bearer fixture-key" },
  ]);
  expect(result.calls).toHaveLength(2);
});
