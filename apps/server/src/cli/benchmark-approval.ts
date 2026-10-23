/** Isolated local benchmark: real Worker/IPC/persistence, no prompts or external tools. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCoreSessionService } from "../runtime/agent/agent-core-session-service.js";
import { ConversationEventHub } from "../runtime/events/conversation-event-hub.js";
import { readSessionApproval } from "../runtime/sandbox/session-approval.js";

const count = Number(process.argv[2] ?? 100);
if (!Number.isInteger(count) || count < 10 || count > 1000) throw new Error("Sample count must be between 10 and 1000");
const root = await mkdtemp(join(tmpdir(), "approval-benchmark-"));
const cwd = join(root, "workspace"); await mkdir(cwd);
process.env.PI_SCIENCE_HOME = join(root, "private");
process.env.PI_SCIENCE_EXECUTION_MODE = "trusted-host";
process.env.PI_SCIENCE_APPROVAL_HOT_SWITCH = "1";
const service = new AgentCoreSessionService(new ConversationEventHub(), { environment: async () => ({}) }, { hasApprovalResources: () => false });
try {
  const created = await service.create(cwd, { model: "openai/gpt-4.1-mini", skills: [], extensions: [] });
  if ("error" in created) throw new Error(created.error);
  let revision = 0;
  const samples = new Map<string, number[]>();
  for (let i = 0; i < count + 4; i++) {
    const mode = i % 2 === 0 ? "auto" : "ask";
    const started = performance.now();
    const result = await service.setApprovalMode(cwd, created.id, mode, revision);
    const duration = performance.now() - started;
    if (!result.success) throw new Error(String(result.error));
    const state = result.data as { revision: number; runtimeRestarted: boolean };
    if (state.runtimeRestarted) throw new Error("Unexpected Worker restart in ordinary hot switch");
    revision = state.revision;
    if (i >= 4) { const direction = mode === "auto" ? "ask → auto" : "auto → ask"; samples.set(direction, [...(samples.get(direction) ?? []), duration]); }
  }
  const current = await readSessionApproval(cwd, created.id);
  const noop = await service.setApprovalMode(cwd, created.id, current.mode, current.revision);
  if ((noop.data as { revision: number }).revision !== current.revision) throw new Error("No-op changed revision");
  console.log(JSON.stringify({ environment: "isolated local real Worker, trusted-host, no tool calls", workers_retained: service.processCount,
    transitions: [...samples].map(([transition, times]) => { times.sort((a, b) => a - b); return {
      transition, samples: times.length, p50_ms: times[Math.ceil(times.length * 0.5) - 1], p95_ms: times[Math.ceil(times.length * 0.95) - 1], max_ms: times.at(-1), worker_restarts: 0,
    }; }),
  }, null, 2));
} finally { await service.shutdownAll(); await rm(root, { recursive: true, force: true }); }
