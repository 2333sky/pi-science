import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeNetworkGrant, revokeNetworkGrant, networkGrantsPath } from "./network-grants.js";
import type { SandboxProfile } from "./profiles.js";
import { workspacePolicy } from "./policy.js";
import { killSandboxGroup, launcherPath, prepareSandbox } from "./process.js";
import { NodeKernelManager } from "../kernel/node-kernel-manager.js";
import { runEnvironmentProcess } from "./environment-process.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { localMcpTransport } from "../../mcp/sandbox-transport.js";
import { JobCoordinator } from "../jobs/job-coordinator.js";
import { sandboxBashTool } from "../agent/worker/sandbox-bash.js";
import { BACKGROUND_CONTEXT, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { writeSandboxFile } from "./file-write.js";
import { builtinMcpConnectors } from "../../mcp/builtin-connectors.js";

const roots: string[] = [];
const managers: NodeKernelManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll())); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(await realpath("/tmp"), "ps-accept-")); roots.push(root); return root; }
async function execute(cwd: string, argv: string[], dependencies: string[] = [], timeoutSeconds = 10, profile: SandboxProfile = "analysis") {
  const prepared = await prepareSandbox(await workspacePolicy(cwd, undefined, profile), argv, dependencies, timeoutSeconds);
  let stdout = "", stderr = "";
  const child = spawn(process.execPath, [launcherPath, prepared.manifest], { cwd, env: prepared.env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout!.on("data", (chunk) => stdout += chunk); child.stderr!.on("data", (chunk) => stderr += chunk);
  try { const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); return { code, stdout, stderr }; }
  finally { killSandboxGroup(child.pid); await prepared.cleanup(); }
}

describe.skipIf(process.env.PI_SCIENCE_SANDBOX_TEST !== "1" || !["darwin", "linux"].includes(process.platform))("real platform sandbox acceptance", () => {
  it("runs real Bash, denies credentials/outside writes/network and captures ordinary output", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("OPENAI_API_KEY", "must-not-be-inherited");
    await writeFile(join(cwd, ".netrc"), "SECRET");
    const result = await execute(cwd, ["/bin/bash", "-c", "set -e; test -z \"$OPENAI_API_KEY\"; test ! -s /etc/passwd; test ! -s .netrc; printf success > result.txt; if curl -sS --max-time 2 https://example.com >/dev/null 2>&1; then exit 77; fi; echo isolated"]);
    // Linux masks denied files with empty files; macOS returns permission errors.
    expect(await readFile(join(cwd, ".netrc"), "utf8")).toBe("SECRET");
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "isolated\n" }); expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("success");
  }, 30_000);
  it("removes descendants which detach and outlive the original command", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const descendant = "setTimeout(()=>require('node:fs').writeFileSync('leaked.txt','escaped'),1500);setInterval(()=>{},1000)";
    const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'}).unref();console.log('spawned')`;
    const result = await execute(cwd, [process.execPath, "-e", code], [process.execPath]);
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "spawned\n" });
    await new Promise((resolve) => setTimeout(resolve, 1700)); await expect(readFile(join(cwd, "leaked.txt"))).rejects.toThrow();
  }, 30_000);
  it("enforces the independent execution deadline", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const started = Date.now();
    const result = await execute(cwd, ["/bin/bash", "-c", "echo ready; sleep 30; touch leaked.txt"], [], 1);
    expect(result.stdout).toContain("ready"); expect(result.code).not.toBe(0); expect(Date.now() - started).toBeLessThan(8000);
    await expect(readFile(join(cwd, "leaked.txt"))).rejects.toThrow();
  }, 15_000);
  it("permits allowlisted HTTPS and refuses an unlisted destination", async () => {
    const cwd = await fixture(), control = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const config = join(control, "profiles.json");
    await writeFile(config, JSON.stringify({ schemaVersion: 1, profiles: { analysis: { allowedDomains: ["example.com"] } } }), { mode: 0o600 });
    vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", config);
    const result = await execute(cwd, ["/bin/bash", "-c", "set -e; curl -sS --fail --max-time 15 https://example.com -o allowed.html; if curl -sS --fail --max-time 2 https://example.org >/dev/null 2>&1; then exit 77; fi; echo filtered"], [], 25);
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "filtered\n" }); expect(await readFile(join(cwd, "allowed.html"), "utf8")).toContain("Example Domain");
  }, 40_000);
  it.skipIf(!process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT)("runs persistent Python cells and isolates the installed environment", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const prefix = process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT!;
    const manager = new NodeKernelManager(); managers.push(manager);
    const options = { cwd, language: "python" as const, environment: { ready: true, workspace: cwd, prefix, python: join(prefix, "bin/python3"), pip: join(prefix, "bin/pip"), npm: { local_prefix: cwd, global_prefix: cwd, cache: cwd } }, timeoutMs: 10_000 };
    expect(await manager.execute({ ...options, code: "state=40\nprint('ready')" })).toMatchObject({ ok: true, stdout: "ready\n" });
    expect(await manager.execute({ ...options, code: "print(state+2)" })).toMatchObject({ ok: true, stdout: "42\n" });
    expect(await manager.execute({ ...options, code: `import os\ntry:\n open(${JSON.stringify(join(prefix, "forbidden-by-sandbox"))},'w'); raise AssertionError('environment writable')\nexcept OSError: pass\nprint('readonly')` })).toMatchObject({ ok: true, stdout: "readonly\n" });
  }, 30_000);
  it.skipIf(!process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT)("grants and revokes network access in a running Python kernel without losing state", async () => {
    const cwd = await fixture(), home = await fixture();
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("PI_SCIENCE_HOME", home); vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", "");
    const prefix = process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT!;
    const manager = new NodeKernelManager(); managers.push(manager);
    const options = { cwd, language: "python" as const, environment: { ready: true, workspace: cwd, prefix, python: join(prefix, "bin/python3"), pip: join(prefix, "bin/pip"), npm: { local_prefix: cwd, global_prefix: cwd, cache: cwd } }, timeoutMs: 20_000 };
    const blocked = "import urllib.request\ntry:\n urllib.request.urlopen('https://example.com',timeout=10)\nexcept Exception:\n print('blocked')\nelse:\n raise AssertionError('network unexpectedly open')";
    expect(await manager.execute({ ...options, code: "state=42\nimport os\noriginal_pid=os.getpid()\n" + blocked })).toMatchObject({ ok: true, stdout: "blocked\n" });
    await changeNetworkGrant({ profile: "analysis", domain: "example.com", decision: "allow" }, "settings");
    const granted = await manager.execute({ ...options, code: "assert state==42 and os.getpid()==original_pid\nprint(urllib.request.urlopen('https://example.com',timeout=15).status)" });
    expect(granted, JSON.stringify(granted)).toMatchObject({ ok: true, stdout: "200\n" });
    for (const profile of ["mcp", "control"] as const) {
      const confined = await execute(cwd, ["/bin/bash", "-c", "if curl -sS --fail --max-time 2 https://example.com >/dev/null 2>&1; then exit 77; fi; echo role-isolated"], [], 5, profile);
      expect(confined, confined.stderr).toMatchObject({ code: 0, stdout: "role-isolated\n" });
    }
    await revokeNetworkGrant("analysis", "example.com");
    expect(await manager.execute({ ...options, code: "assert state==42 and os.getpid()==original_pid\n" + blocked })).toMatchObject({ ok: true, stdout: "blocked\n" });
    expect(await manager.execute({ ...options, code: `try:\n open(${JSON.stringify(networkGrantsPath())}).read()\nexcept OSError:\n print('permissions-protected')\nelse:\n raise AssertionError('permission state exposed')` })).toMatchObject({ ok: true, stdout: "permissions-protected\n" });
  }, 60_000);
  it("confines installer writes to its new prefix and cache", async () => {
    const root = await fixture(), prefix = join(root, "env"), cache = join(root, "pkgs"), workspace = join(root, "workspace");
    await mkdir(workspace); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    await runEnvironmentProcess("/bin/bash", ["-c", `set -e; test -s "$CONDA_SSL_VERIFY"; test "$CONDA_SSL_VERIFY" = "$MAMBA_SSL_VERIFY"; test -z "$(ls -A '${prefix}')"; touch '${prefix}/installed'; touch '${cache}/cached'; if touch '${workspace}/escaped' 2>/dev/null; then exit 77; fi`], prefix, cache, 10_000);
    expect(await readFile(join(prefix, "installed"), "utf8")).toBe(""); await expect(readFile(join(workspace, "escaped"))).rejects.toThrow();
  }, 30_000);
  it("confines a real MCP server while passing only its own explicitly bound credential", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("OPENAI_API_KEY", "host-model-key");
    const script = join(cwd, "server.mjs");
    await writeFile(script, `import {McpServer} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};\nimport {StdioServerTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};\nimport fs from 'node:fs';\nconst server=new McpServer({name:'isolated',version:'1'});server.registerTool('inspect',{},async()=>({content:[{type:'text',text:JSON.stringify({token:process.env.TOKEN,hostKey:!!process.env.OPENAI_API_KEY,passwd:fs.existsSync('/etc/passwd')})}]}));await server.connect(new StdioServerTransport());`);
    const transport = await localMcpTransport(cwd, process.execPath, [script], cwd, { TOKEN: "connector-only" });
    const client = new Client({ name: "acceptance", version: "1" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "inspect", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ token: "connector-only", hostKey: false, passwd: false }) }]);
    } finally { await client.close(); }
  }, 30_000);
  it("starts the product's built-in Paper Search server inside the MCP sandbox", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const definition = builtinMcpConnectors()[0]!.definition;
    const client = new Client({ name: "builtin-acceptance", version: "1" });
    try {
      await client.connect(await localMcpTransport(cwd, definition.command!, definition.args, cwd, {}));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("search_pubmed");
    } finally { await client.close(); }
  }, 30_000);
  it("calls arXiv and OpenAlex through HTTPS without DNS in the real MCP sandbox", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const key = join(cwd, "test-key.pem"), cert = join(cwd, "test-cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
      "-days", "1", "-subj", "/CN=sandbox-test", "-addext", "subjectAltName=DNS:export.arxiv.org,DNS:api.openalex.org"], { stdio: "ignore" });
    for (const [connectorId, tool, args] of [
      ["mcp_builtin_paper_search", "search_arxiv", { query: "sandbox DNS", limit: 1 }],
      ["mcp_builtin_literature_graph", "search_openalex_works", { query: "sandbox DNS", per_page: 1 }],
    ] as const) {
      const definition = builtinMcpConnectors().find((connector) => connector.connector_id === connectorId)!.definition;
      const wrapper = join(cwd, `${tool}.mjs`);
      const entryIndex = definition.args!.findIndex((arg) => /\.(?:ts|js)$/.test(arg));
      const entry = definition.args![entryIndex]!;
      // Controlled HTTPS upstream only: real TLS verification, real SDK tool
      // handlers and transport, no external API or DNS dependency. The workload
      // still uses the product's normal Linux OS confinement.
      await writeFile(wrapper, `import fs from 'node:fs';
process.on('uncaughtException', error=>{fs.writeFileSync(${JSON.stringify(join(cwd, 'fixture-error.txt'))},String(error.stack));process.exit(1)});
import http from 'node:http';
import tls from 'node:tls';
import dns from 'node:dns/promises';
if(fs.existsSync('/etc/resolv.conf')) throw Error('test requires isolated DNS');
try { await dns.lookup('no-dns.invalid'); throw Error('DNS unexpectedly available'); }
catch(error) { if(error.code !== 'ENOTFOUND' && error.code !== 'EAI_AGAIN') throw error; }
tls.setDefaultCACertificates([...tls.getCACertificates(),${JSON.stringify(await readFile(cert, "utf8"))}]);
const context=tls.createSecureContext({key:${JSON.stringify(await readFile(key, "utf8"))},cert:${JSON.stringify(await readFile(cert, "utf8"))}});
const proxy=http.createServer();
proxy.on('connect',(req,socket)=>{
 socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
 const secure=new tls.TLSSocket(socket,{isServer:true,secureContext:context});
 secure.once('data',()=>{
  const arxiv=req.url==='export.arxiv.org:443';
  if(!arxiv && req.url!=='api.openalex.org:443') throw Error('Unexpected upstream');
  const body=arxiv?'<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>0</opensearch:totalResults></feed>':JSON.stringify({meta:{count:0},results:[]});
  secure.end('HTTP/1.1 200 OK\\r\\nContent-Type: '+(arxiv?'application/atom+xml':'application/json')+'\\r\\nContent-Length: '+Buffer.byteLength(body)+'\\r\\nConnection: close\\r\\n\\r\\n'+body);
 });
});
await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
process.env.PI_SCIENCE_SANDBOX_HTTP_PROXY='http://127.0.0.1:'+proxy.address().port;
process.env.NO_PROXY='*'; process.env.no_proxy='*';
process.argv=[process.argv[0],...${JSON.stringify(definition.args!.slice(entryIndex))}];
${entry.endsWith(".ts") ? `await import(${JSON.stringify(import.meta.resolve("tsx"))});` : ""}
await import(${JSON.stringify(new URL(entry, "file:///").href)});
`);
      const client = new Client({ name: "dns-acceptance", version: "1" });
      try {
        await client.connect(await localMcpTransport(cwd, definition.command!, [wrapper], cwd, {}));
        const result = await client.callTool({ name: tool, arguments: args });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ records: [], total: 0 });
      } catch (error) { throw new Error(await readFile(join(cwd, "fixture-error.txt"), "utf8").catch(() => String(error))); }
      finally { await client.close(); }
    }
  }, 40_000);

  it("routes unresolved MCP hostnames to the real policy proxy and rejects connector proxy overrides", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const script = join(cwd, "proxy-check.mjs");
    const fetchModule = new URL("../../mcp/runtime-fetch.js", import.meta.url.replace(/\.ts$/, ".js")).href.replace("/src/", "/dist/");
    await writeFile(script, `import {createMcpFetch} from ${JSON.stringify(fetchModule)};
if(!process.env.PI_SCIENCE_SANDBOX_HTTP_PROXY?.startsWith('http://127.0.0.1:')) throw Error('missing trusted proxy');
try { await createMcpFetch({connectorId:'test',endpoint:'https://no-dns.invalid',allowPrivate:false})('https://no-dns.invalid'); throw Error('unexpected access'); }
catch(error) { let message=''; for(let cause=error;cause;cause=cause.cause) message+=String(cause.message); if(!message.includes('Proxy response (403)')) throw error; console.log('policy-proxy-denied-without-DNS'); }
`);
    const policy = await workspacePolicy(cwd, undefined, "mcp");
    const prepared = await prepareSandbox(policy, [process.execPath, script], [process.execPath, new URL("../../../", import.meta.url).pathname, new URL("../../../../../node_modules", import.meta.url).pathname], 10,
      undefined, undefined, { PI_SCIENCE_SANDBOX_HTTP_PROXY: "http://attacker.invalid:1", NO_PROXY: "*" });
    const child = spawn(process.execPath, [launcherPath, prepared.manifest], { cwd, env: prepared.env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (data) => stdout += data); child.stderr!.on("data", (data) => stderr += data);
    try {
      const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
      expect({ code, stdout }, stderr).toEqual({ code: 0, stdout: "policy-proxy-denied-without-DNS\n" });
    } finally { killSandboxGroup(child.pid); await prepared.cleanup(); }
  }, 30_000);
  it("preserves the actual Bash tool output and artifact path through its OS adapter", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const result = await sandboxBashTool({ cwd, sessionId: "acceptance" }).execute("bash", { command: "test ! -r /etc/passwd && printf result > result.txt && echo bash-tool-isolated", timeout: 10 }, () => {}, { env: new NodeExecutionEnv({ cwd }) },
      { operationId: "operation", invocationId: "bash", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} }, BACKGROUND_CONTEXT);
    expect(JSON.stringify(result.content)).toContain("bash-tool-isolated"); expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("result");
  }, 30_000);
  it.skipIf(process.platform !== "darwin")("performs native file-tool commits inside a confined helper", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    await writeSandboxFile(cwd, join(cwd, "nested", "file.txt"), "saved");
    expect(await readFile(join(cwd, "nested", "file.txt"), "utf8")).toBe("saved");
    await expect(writeSandboxFile(cwd, join(cwd, ".pi-science", "blocked"), "must-not-write")).rejects.toThrow();
    await expect(readFile(join(cwd, ".pi-science", "blocked"))).rejects.toThrow();
  }, 30_000);
  it("keeps background jobs inside the same sandbox despite request-shaped mode overrides", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const jobs = new JobCoordinator({ environment: async () => ({ PATH: "/usr/bin:/bin" }) });
    try {
      const record = await jobs.submit(cwd, { command: ["/bin/bash", "-c", "test ! -r /etc/passwd && echo job-isolated"], env: { PI_SCIENCE_EXECUTION_MODE: "trusted-host" } });
      let result = record;
      for (let i = 0; i < 200; i++) { result = (await jobs.get(cwd, record.job_id))!; if (["succeeded", "failed", "cancelled", "timed_out"].includes(result.status)) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
      expect(result).toMatchObject({ status: "succeeded", stdout: "job-isolated\n", environment: { execution_mode: "required", sandbox_policy_id: expect.any(String) } });
    } finally { await jobs.shutdown(); }
  }, 30_000);
});
