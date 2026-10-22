// Run after building the server. --live also contacts public search/page services.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../dist/model-resources/credential-store.js";
import { SettingsStore } from "../dist/storage/settings-store.js";
import { webTools } from "../dist/web/tools.js";
import { builtinMcpConnectors } from "../dist/mcp/builtin-connectors.js";

const live = process.argv.includes("--live");
const root = await mkdtemp(join(tmpdir(), "pi-native-web-smoke-"));
process.env.PI_SCIENCE_HOME = root;
assert.equal(builtinMcpConnectors().some(item => item.connector_id === "mcp_builtin_web_access"), false);
function pdfFixture() {
  const stream = "BT /F1 12 Tf 72 720 Td (Scientific PDF fixture.) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
if (!live) globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith(".pdf")) return new Response(pdfFixture(), { headers: { "content-type": "application/pdf" } });
  return new Response(`<html><head><title>Fixture</title></head><body><article><h1>Native web fixture</h1><p>${"Scientific evidence. ".repeat(100)}</p></article></body></html>`, { headers: { "content-type": "text/html" } });
};
try {
  const tools = await webTools();
  assert.deepEqual(tools.map(tool => tool.name), ["web_search", "web_fetch"]);
  const call = async (name, params) => {
    const result = await tools.find(tool => tool.name === name).execute("smoke", params, () => {}, {}, {}, { abortSignal: AbortSignal.timeout(60_000) });
    assert.equal(result.isError, undefined, JSON.stringify(result.content).slice(0, 1000));
    return result;
  };
  const page = await call("web_fetch", { url: live ? "https://example.com" : "https://93.184.216.34/page", mode: "raw" });
  assert.ok(page.content.some(part => part.type === "text" && part.text.length > 20));
  if (!live) {
    const readable = await call("web_fetch", { url: "https://93.184.216.34/readable" });
    assert.ok(JSON.stringify(readable.content).includes("Scientific evidence"));
    const pdf = await call("web_fetch", { url: "https://93.184.216.34/document.pdf" });
    assert.ok(JSON.stringify(pdf.content).includes("Scientific PDF fixture"), JSON.stringify(pdf.content));
    const cachedPdf = await call("web_fetch", { responseId: pdf.details.responseId, offset: 0, limit: 500 });
    assert.ok(JSON.stringify(cachedPdf.content).includes("Scientific PDF fixture"));
  }
  const config = JSON.parse(await readFile(join(root, "web/runtime/web-search.json"), "utf8"));
  assert.deepEqual(config.ssrf, { allowRanges: [], trustEnvProxy: false });
  assert.equal(config.githubClone.enabled, false);
  const blocked = await tools[1].execute("blocked", { url: "http://127.0.0.1", mode: "raw" }, () => {}, {}, {}, {});
  assert.equal(blocked.isError, true);
  if (live) await call("web_search", { query: "scientific research", numResults: 1 });
  if (!live) {
    const credential = await new CredentialStore().put({ kind: "api_key", backend: "managed", secret: "deepseek-smoke-key" });
    await new SettingsStore().update(config => { config.web_access = { provider: "deepseek", credential_refs: { deepseek: credential.id } }; });
    const paths = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); paths.push(url.pathname);
      assert.equal(url.origin, "https://api.deepseek.com");
      assert.equal(init.headers.Authorization, "Bearer deepseek-smoke-key");
      return Response.json(url.pathname.endsWith("/search")
        ? { results: [{ title: "DeepSeek fixture", url: "https://example.com", snippet: "Evidence", summary: "Search evidence" }] }
        : { title: "DeepSeek fixture", content: "# Fetch evidence" });
    };
    const search = await call("web_search", { query: "science" });
    assert.ok(JSON.stringify(search.content).includes("Search evidence"));
    const page = await call("web_fetch", { url: "https://93.184.216.34/page" });
    assert.ok(JSON.stringify(page.content).includes("# Fetch evidence"));
    const cached = await call("web_fetch", { responseId: page.details.responseId, offset: 0, limit: 100 });
    assert.ok(JSON.stringify(cached.content).includes("# Fetch evidence"));
    assert.deepEqual(paths, ["/v1/tools/search", "/v1/tools/fetch"]);
  }
  console.log("Native web_search/web_fetch: compiled core, DeepSeek Search/Fetch, extraction, isolated configuration and SSRF guard OK");
} finally { await rm(root, { recursive: true, force: true }); }
