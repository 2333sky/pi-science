import { EventEmitter } from "node:events";
import { mkdtemp, realpath, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { bindSubagentDispatch } from "./subagent-dispatch.js";
import { SubagentBridge } from "./worker/subagent-tool.js";
import type { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { AgentRuntimeManager } from "./agent-runtime-manager.js";

const hidden = vi.hoisted(() => ({ open: vi.fn(), run: vi.fn() }));
vi.mock("./hidden-agent-task.js", () => ({ openHiddenTask: hidden.open, runHiddenPrompt: hidden.run }));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("aborts a collect wait promptly while background work remains collectible and drains without its old timer", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-science-collect-abort-")));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi/agents"), { recursive: true });
  await writeFile(join(cwd, ".pi/agents/runner.md"), "---\nname: runner\ntools: []\n---\nRunner");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const child = Object.assign(new EventEmitter(), { sessionId: "child", sendCommand: vi.fn(async () => ({ success: true, data: {} })) });
  hidden.open.mockResolvedValue(child);
  hidden.run.mockImplementation(async () => { await blocked; return "Child completed after cancelled collection."; });
  const stop = vi.fn(async () => undefined);
  const parent = Object.assign(new EventEmitter(), { sessionId: "parent", isClosed: false,
    sendCommand: vi.fn(async (name: string) => ({ success: true, data: name === "get_state" ? { activeTools: ["subagent", "subagent_control"] } : { skills: [], policy: { mode: "none" } } })),
    sendNotification: vi.fn(async (_name: string, params: Record<string, unknown>) => bridge.respond(params)),
  });
  const bridge = new SubagentBridge((event) => parent.emit("event", event));
  const drain = bindSubagentDispatch({ stop } as unknown as AgentRuntimeManager, parent as unknown as AgentCoreRuntimeClient, { cwd, sessionsRoot: join(cwd, ".pi-science/sessions"), model: { provider: "test", modelId: "test" } });
  try {
    const dispatched = await bridge.request({ operationId: "operation", invocationId: "invocation", params: { agent: "runner", task: "Wait", wait_seconds: 0 } });
    const taskId = (dispatched.data as { details: { task_id: string } }).details.task_id;
    await vi.waitFor(() => expect(hidden.run).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const responseCount = parent.sendNotification.mock.calls.length;
    const collect = bridge.request({ params: { action: "collect", task_id: taskId, wait_seconds: 600 } }, controller.signal, "subagent.control");
    // Abort after the host has entered its collection wait.
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    expect(await collect).toMatchObject({ success: false, error: "Subagent cancelled" });
    await vi.waitFor(() => expect(parent.sendNotification.mock.calls.length).toBe(responseCount + 1));
    expect(stop).not.toHaveBeenCalled();
    const status = await bridge.request({ params: { action: "status", task_id: taskId } }, undefined, "subagent.control");
    expect(status).toMatchObject({ success: true, data: { details: { status: "running" } } });
    release();
    const result = await bridge.request({ params: { action: "collect", task_id: taskId, wait_seconds: 10 } }, undefined, "subagent.control");
    expect(result).toMatchObject({ success: true, data: { details: { status: "completed" } } });
    expect(JSON.stringify(result)).toContain("Child completed after cancelled collection.");
    await drain();
    expect(drain.isBusy()).toBe(false);
    expect(hidden.run).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  } finally { release(); await drain(); }
}, 5000);

it.each([
  { declaration: "execution_scope: candidate\n", candidate_id: undefined, inherited: undefined },
  { declaration: "", candidate_id: "one", inherited: undefined },
  { declaration: "execution_scope: workspace\n", candidate_id: undefined, inherited: "candidate" as const },
])("binds a generic restricted role at dispatch: %j", async ({ declaration, candidate_id, inherited }) => {
  hidden.open.mockClear(); hidden.run.mockClear();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-science-scope-")));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi/agents"), { recursive: true });
  await writeFile(join(cwd, ".pi/agents/optimizer.md"), `---\n${declaration}tools: [read, bash, write, subagent, mcp__science__execute]\n---\nOptimizer`);
  if (candidate_id) {
    const home = await mkdtemp(join(tmpdir(), "dispatch-grant-home-")); cleanup.push(() => rm(home, { recursive: true, force: true })); vi.stubEnv("PI_SCIENCE_HOME", home);
    await mkdir(join(cwd, "research/study/candidates/one/input"), { recursive: true });
    await mkdir(join(cwd, "research/study/candidates/one/work"));
    const { ExecutionBudgetLedger } = await import("../executions/execution-budget.js");
    await new ExecutionBudgetLedger(cwd, "op").configure({}, "study");
  }
  const child = Object.assign(new EventEmitter(), { sessionId: "child", sendCommand: vi.fn(async () => ({ success: true, data: {} })) });
  hidden.open.mockResolvedValue(child); hidden.run.mockResolvedValue("Proposed implementation.");
  const parent = Object.assign(new EventEmitter(), { sessionId: "parent", isClosed: false,
    sendCommand: vi.fn(async (name: string) => ({ success: true, data: name === "get_state" ? { activeTools: ["read", "bash", "write", "subagent", "mcp__science__execute"] } : { skills: [], policy: { mode: "none" } } })),
    sendNotification: vi.fn(async (_name: string, params: Record<string, unknown>) => bridge.respond(params)),
  });
  const bridge = new SubagentBridge((event) => parent.emit("event", event));
  const drain = bindSubagentDispatch({ stop: vi.fn() } as unknown as AgentRuntimeManager, parent as unknown as AgentCoreRuntimeClient,
    { cwd, executionScope: inherited, sessionsRoot: join(cwd, ".pi-science/sessions"), model: { provider: "test", modelId: "test" } });
  try {
    const response = await bridge.request({ operationId: "op", invocationId: "run", params: { agent: "optimizer", task: "Implement", candidate_id } });
    expect(response.success).toBe(true);
    expect(hidden.open.mock.calls[0]![2]).toMatchObject({ executionScope: "candidate", allowedTools: ["read", "bash"] });
    // Model parameters cannot replace the service-bound scope or request a wider tool ceiling.
    for (const extra of [{ executionScope: "workspace" }, { execution_scope: "workspace" }, { tools: ["write"] }]) {
      expect((await bridge.request({ operationId: "op", invocationId: JSON.stringify(extra), params: { agent: "optimizer", task: "Escape", candidate_id, ...extra } })).success).toBe(false);
    }
    expect(hidden.open).toHaveBeenCalledOnce();
  } finally { await drain(); }
});

it.each(["bound", "unknown", "committed"])("keeps recovered tasks restricted after role metadata is removed: %s", async (scenario) => {
  const recorded = scenario === "bound";
  hidden.open.mockClear(); hidden.run.mockClear();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-science-scope-recovery-"))); cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi/agents"), { recursive: true });
  await writeFile(join(cwd, ".pi/agents/optimizer.md"), "---\ntools: [read, bash, write]\n---\nRole now requests workspace access");
  const { createHash } = await import("node:crypto");
  const { workspaceFile, writeJsonAtomic } = await import("../../storage/persistence.js");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const taskId = hash(JSON.stringify(["parent", "op", "invocation"]));
  const { ExecutionBudgetLedger } = await import("../executions/execution-budget.js");
  await new ExecutionBudgetLedger(cwd, "op").status();
  await writeJsonAtomic(workspaceFile(cwd, `agent-tasks/${hash("parent")}/${taskId}.json`), {
    task_id: taskId, owner: "parent", operationId: "op", invocationId: "invocation", budget_owner: "op",
    params: { agent: "optimizer", task: "Resume", tools: ["read", "bash"] },
    ...(recorded ? { executionScopes: ["candidate"] } : {}), deadline: Date.now() + 60_000, status: "running",
  });
  if (scenario === "committed") {
    const key = `subagent:${cwd}:parent:op:invocation:0`;
    await writeJsonAtomic(workspaceFile(cwd, `agent-task-results/${hash(key)}.json`), { agent: "optimizer", output: "Previously committed.", exitCode: 0 });
  }
  const child = Object.assign(new EventEmitter(), { sessionId: "child", sendCommand: vi.fn(async () => ({ success: true, data: {} })) });
  hidden.open.mockResolvedValue(child); hidden.run.mockResolvedValue("Proposed code only.");
  const parent = Object.assign(new EventEmitter(), { sessionId: "parent", isClosed: false,
    sendCommand: vi.fn(async (name: string) => ({ success: true, data: name === "get_state" ? { activeTools: ["read", "bash", "write", "subagent"] } : { skills: [], policy: { mode: "none" } } })),
    sendNotification: vi.fn(async (_name: string, params: Record<string, unknown>) => bridge.respond(params)),
  });
  const bridge = new SubagentBridge((event) => parent.emit("event", event));
  const drain = bindSubagentDispatch({ stop: vi.fn() } as unknown as AgentRuntimeManager, parent as unknown as AgentCoreRuntimeClient,
    { cwd, sessionsRoot: join(cwd, ".pi-science/sessions"), model: { provider: "test", modelId: "test" } });
  try {
    const result = await bridge.request({ params: { action: "collect", task_id: taskId, wait_seconds: 10 } }, undefined, "subagent.control");
    if (recorded) {
      expect(result).toMatchObject({ success: true });
      expect(hidden.open.mock.calls[0]![2]).toMatchObject({ executionScope: "candidate", allowedTools: ["read", "bash"] });
    } else if (scenario === "committed") {
      expect(result).toMatchObject({ success: true, data: { details: { status: "completed" } } });
      expect(JSON.stringify(result)).toContain("Previously committed.");
      expect(hidden.open).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ success: true, data: { details: { status: "failed", error_code: "scope_migration_required", recoverable: false } } });
      expect(hidden.open).not.toHaveBeenCalled();
    }
  } finally { await drain(); }
});

it("reports missing Skill scope before dispatch and admits it only after an explicit migration", async () => {
  hidden.open.mockClear(); hidden.run.mockClear();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "skill-scope-migration-"))); cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi/skills/document-audit/agents"), { recursive: true });
  await writeFile(join(cwd, ".pi/skills/document-audit/SKILL.md"), "---\nname: document-audit\ndescription: Audit\nlicense: MIT\n---\nAudit");
  const path = join(cwd, ".pi/skills/document-audit/agents/auditor.md");
  await writeFile(path, "---\ntools: [read, write]\n---\nAuditor");
  const child = Object.assign(new EventEmitter(), { sessionId: "child", sendCommand: vi.fn(async () => ({ success: true, data: {} })) });
  hidden.open.mockResolvedValue(child); hidden.run.mockResolvedValue("Audit completed.");
  const parent = Object.assign(new EventEmitter(), { sessionId: "parent", isClosed: false,
    sendCommand: vi.fn(async (name: string) => ({ success: true, data: name === "get_state" ? { activeTools: ["read", "write", "subagent"] } : { skills: [{ name: "document-audit", enabled: true }], policy: { mode: "inherit" } } })),
    sendNotification: vi.fn(async (_name: string, params: Record<string, unknown>) => bridge.respond(params)),
  });
  const bridge = new SubagentBridge((event) => parent.emit("event", event));
  const drain = bindSubagentDispatch({ stop: vi.fn() } as unknown as AgentRuntimeManager, parent as unknown as AgentCoreRuntimeClient,
    { cwd, sessionsRoot: join(cwd, ".pi-science/sessions"), model: { provider: "test", modelId: "test" } });
  try {
    const denied = await bridge.request({ operationId: "op", invocationId: "old", params: { agent: "document-audit/auditor", task: "Audit" } });
    expect(denied).toMatchObject({ success: false, code: "scope_migration_required" });
    expect(denied.error).toContain("missing execution_scope");
    expect(hidden.open).not.toHaveBeenCalled();
    await writeFile(path, "---\nexecution_scope: workspace\ntools: [read, write]\n---\nAuditor");
    expect(await bridge.request({ operationId: "op", invocationId: "new", params: { agent: "document-audit/auditor", task: "Audit" } })).toMatchObject({ success: true });
    expect(hidden.open.mock.calls[0]![2]).toMatchObject({ executionScope: "workspace", allowedTools: ["read", "write"] });
  } finally { await drain(); }
});

it.each(["single", "chain", "parallel"])("persists a non-resumable migration outcome for legacy workspace tasks: %s", async (mode) => {
  hidden.open.mockClear(); hidden.run.mockClear();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "task-scope-migration-"))); cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi/agents"), { recursive: true });
  const rolePath = join(cwd, ".pi/agents/auditor.md");
  await writeFile(rolePath, "---\nexecution_scope: workspace\ntools: [read, write]\n---\nAuditor");
  const { createHash } = await import("node:crypto");
  const { workspaceFile, writeJsonAtomic, readJson } = await import("../../storage/persistence.js");
  const { ExecutionBudgetLedger } = await import("../executions/execution-budget.js");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const taskId = hash(JSON.stringify(["parent", "op", "old"]));
  const item = { agent: "auditor", task: "Resume audit", tools: ["read", "write"] };
  const params = mode === "single" ? item : mode === "chain" ? { chain: [item] } : { tasks: [item] };
  const path = workspaceFile(cwd, `agent-tasks/${hash("parent")}/${taskId}.json`);
  const budget = new ExecutionBudgetLedger(cwd, "op"); const before = await budget.status();
  await writeJsonAtomic(path, { task_id: taskId, owner: "parent", operationId: "op", invocationId: "old", budget_owner: "op", params, deadline: Date.now() + 60_000, status: "running" });
  const connect = () => {
    const parent = Object.assign(new EventEmitter(), { sessionId: "parent", isClosed: false,
      sendCommand: vi.fn(async (name: string) => ({ success: true, data: name === "get_state" ? { activeTools: ["read", "write", "subagent"] } : { skills: [], policy: { mode: "none" } } })),
      sendNotification: vi.fn(async (_name: string, value: Record<string, unknown>) => bridge.respond(value)),
    });
    const bridge = new SubagentBridge((event) => parent.emit("event", event));
    const drain = bindSubagentDispatch({ stop: vi.fn() } as unknown as AgentRuntimeManager, parent as unknown as AgentCoreRuntimeClient,
      { cwd, sessionsRoot: join(cwd, ".pi-science/sessions"), model: { provider: "test", modelId: "test" } });
    return { bridge, drain };
  };
  let connection = connect();
  const collect = () => connection.bridge.request({ params: { action: "collect", task_id: taskId, wait_seconds: 10 } }, undefined, "subagent.control");
  try {
    const first = await collect();
    expect(first).toMatchObject({ success: true, data: { details: { status: "failed", error_code: "scope_migration_required", recoverable: false } } });
    expect(JSON.stringify(first)).toContain("new subagent invocation");
    expect(JSON.stringify(first)).toContain("Inspect committed results");
    expect(await collect()).toEqual(first);
    await connection.drain();
    // A new dispatcher and a changed current role cannot upgrade the historical record.
    await writeFile(rolePath, "---\nexecution_scope: candidate\ntools: [read]\n---\nChanged role");
    connection = connect();
    expect(await collect()).toEqual(first);
    expect(await connection.bridge.request({ params: { action: "status", task_id: taskId } }, undefined, "subagent.control")).toEqual(first);
    expect(await connection.bridge.request({ operationId: "op", invocationId: "old", params })).toEqual(first);
    expect(await readJson(path, null)).toMatchObject({ status: "failed", error_code: "scope_migration_required" });
    expect(await budget.status()).toEqual(before);
    expect(hidden.open).not.toHaveBeenCalled(); expect(hidden.run).not.toHaveBeenCalled();
  } finally { await connection.drain(); }
});

async function inheritedToolsFixture(declaration = "") {
  hidden.open.mockReset(); hidden.run.mockReset();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "parent-tools-")));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi/agents"), { recursive: true });
  const { ExecutionBudgetLedger } = await import("../executions/execution-budget.js"); await new ExecutionBudgetLedger(cwd, "op").status();
  const role = join(cwd, ".pi/agents/auditor.md");
  await writeFile(role, `---\nexecution_scope: workspace\n${declaration}---\nAuditor`);
  let parentTools = ["read", "write", "mcp__new-vendor__retrieve", "ask_user_question", "sandbox_run", "subagent"];
  const child = Object.assign(new EventEmitter(), { sessionId: "child", sendCommand: vi.fn(async () => ({ success: true, data: {} })), sendNotification: vi.fn(async () => undefined) });
  hidden.open.mockResolvedValue(child); hidden.run.mockResolvedValue("Audited");
  const parent = Object.assign(new EventEmitter(), { sessionId: "parent", isClosed: false,
    sendCommand: vi.fn(async (name: string) => ({ success: true, data: name === "get_state" ? { activeTools: parentTools } : { skills: [], policy: { mode: "none" } } })),
    sendNotification: vi.fn(async (_name: string, value: Record<string, unknown>) => bridge.respond(value)),
  });
  const bridge = new SubagentBridge((event) => parent.emit("event", event));
  const drain = bindSubagentDispatch({ stop: vi.fn(async () => {}) } as unknown as AgentRuntimeManager, parent as unknown as AgentCoreRuntimeClient,
    { cwd, sessionsRoot: join(cwd, ".pi-science/sessions"), model: { provider: "test", modelId: "test" } });
  cleanup.push(drain);
  return { cwd, role, child, bridge, drain, setParentTools: (tools: string[]) => { parentTools = tools; } };
}

it.each([
  { declaration: "", tools: undefined, expected: ["read", "write", "mcp__new-vendor__retrieve", "subagent"] },
  { declaration: "tools: []\n", tools: undefined, expected: [] },
  { declaration: "tools: [read]\n", tools: undefined, expected: ["read"] },
  { declaration: "", tools: [], expected: [] },
  { declaration: "", tools: ["mcp__new-vendor__retrieve"], expected: ["mcp__new-vendor__retrieve"] },
])("persists effective Parent/role/task permissions: %j", async ({ declaration, tools, expected }) => {
  const { cwd, bridge } = await inheritedToolsFixture(declaration);
  const result = await bridge.request({ operationId: "op", invocationId: "inherit", params: { agent: "auditor", task: "Audit", ...(tools !== undefined ? { tools } : {}) } });
  expect(result.success).toBe(true);
  expect(hidden.open.mock.calls[0]![2].allowedTools).toEqual(expected);
  const { workspaceFile, readJson } = await import("../../storage/persistence.js");
  const { createHash } = await import("node:crypto");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const path = workspaceFile(cwd, `agent-tasks/${hash("parent")}/${hash(JSON.stringify(["parent", "op", "inherit"]))}.json`);
  expect(await readJson(path, null)).toMatchObject({ params: { tools: expected }, executionScopes: ["workspace"] });
});

it("refuses explicit task tools outside the Parent or role ceiling", async () => {
  const { bridge } = await inheritedToolsFixture("tools: [read]\n");
  const result = await bridge.request({ operationId: "op", invocationId: "excess", params: { agent: "auditor", task: "Audit", tools: ["write"] } });
  expect(result.success).toBe(false); expect(hidden.open).not.toHaveBeenCalled();
});

it.each(["authorized", "parent-revoked", "role-revoked", "role-widened"])("rechecks every capability against the admitted snapshot: %s", async (change) => {
  const { role, bridge, child, setParentTools } = await inheritedToolsFixture(change === "role-widened" ? "tools: [read]\n" : "");
  hidden.run.mockImplementation(async () => {
    if (change === "parent-revoked") setParentTools(["read", "subagent"]);
    else if (change !== "authorized") await writeFile(role, `---\nexecution_scope: workspace\n${change === "role-revoked" ? "tools: []\n" : ""}---\nChanged role`);
    child.emit("event", { type: "capability.requested", id: "permission", tool: "mcp__new-vendor__retrieve" });
    await vi.waitFor(() => expect(child.sendNotification).toHaveBeenCalled());
    expect(child.sendNotification.mock.calls[0]).toMatchObject(["subagent_response", { result: change === "authorized" ? { success: true } : { success: false, error: expect.stringContaining("revoked") } }]);
    return "Denied correctly";
  });
  const result = await bridge.request({ operationId: "op", invocationId: "live", params: { agent: "auditor", task: "Audit" } });
  expect(result.success).toBe(true);
});

it.each(["read", "missing", "revoked"])("does not reconstruct or widen historical tool snapshots on collect: %s", async (snapshot) => {
  const { cwd, bridge, setParentTools } = await inheritedToolsFixture();
  if (snapshot === "revoked") setParentTools(["subagent"]);
  const { workspaceFile, writeJsonAtomic } = await import("../../storage/persistence.js");
  const { createHash } = await import("node:crypto");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const id = hash(JSON.stringify(["parent", "op", "old-tools"]));
  await writeJsonAtomic(workspaceFile(cwd, `agent-tasks/${hash("parent")}/${id}.json`), { task_id: id, owner: "parent", operationId: "op", invocationId: "old-tools", budget_owner: "op",
    params: { agent: "auditor", task: "Audit", ...(snapshot === "missing" ? {} : { tools: ["read"] }) }, executionScopes: ["workspace"], deadline: Date.now() + 60_000, status: "running" });
  const result = await bridge.request({ params: { action: "collect", task_id: id, wait_seconds: 10 } }, undefined, "subagent.control");
  if (snapshot === "read") {
    expect(result.success).toBe(true); expect(hidden.open.mock.calls[0]![2].allowedTools).toEqual(["read"]);
  } else {
    expect(result.success).toBe(false); expect(hidden.open).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain(snapshot === "missing" ? "no persisted tool permissions" : "revoked");
  }
});
