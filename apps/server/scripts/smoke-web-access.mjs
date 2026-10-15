// Run after building the server. --live additionally needs public-web access.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { builtinMcpConnectors } from "../dist/mcp/builtin-connectors.js";
import { builtinNetworkEnvironment, mcpBaseEnvironment } from "../dist/mcp/bindings.js";

const live = process.argv.includes("--live");
const cwd = await mkdtemp(join(tmpdir(), "pi-science-web-smoke-"));
const builtin = builtinMcpConnectors().find((item) => item.connector_id === "mcp_builtin_web_access");
assert.ok(builtin);
assert.equal(builtin.definition.command, process.execPath);
const client = new Client({ name: "pi-science-web-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: builtin.definition.command, args: builtin.definition.args, cwd,
  env: { ...mcpBaseEnvironment(), ...builtinNetworkEnvironment(), PI_CODING_AGENT_DIR: cwd }, stderr: "pipe",
});
try {
  await writeFile(join(cwd, "web-search.json"), JSON.stringify({
    provider: "exa", githubClone: { enabled: false }, githubPrIssue: { enabled: false },
  }));
  await client.connect(transport, { timeout: 10_000 });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), builtin.tools.map((tool) => tool.name).sort());
  console.log("Web Access compiled entry: handshake and four tools OK");
  if (live) {
    const failures = [];
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      if (result.isError) throw new Error(`${name}: ${text.slice(0, 1200)}`);
      console.log(`${name}: OK`);
      return text;
    };
    try { await call("web_search", { query: "MCP model context protocol", provider: "exa", numResults: 1 }); }
    catch (error) { failures.push(error); }
    try {
      const text = await call("fetch_content", { url: "https://raw.githubusercontent.com/nicobailon/pi-web-access/main/README.md", mode: "raw" });
      const responseId = text.match(/responseId "([^"]+)"/)?.[1];
      assert.ok(responseId, "fetch must return a retrievable responseId");
      await call("get_search_content", { responseId, urlIndex: 0, offset: 0, limit: 500 });
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Live Web Access validation failed");
  }
} finally {
  await client.close();
  assert.equal(transport.pid, null);
  await rm(cwd, { recursive: true, force: true });
}
