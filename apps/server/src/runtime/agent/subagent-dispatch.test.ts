import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

it("aborts a collect wait promptly while background work remains collectible and drains without its old timer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-collect-abort-"));
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
