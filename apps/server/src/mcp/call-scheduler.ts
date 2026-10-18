import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { readJson, withFileWriteLock, workspaceFile, writeJsonAtomic } from "../storage/persistence.js";

const ticket = z.object({ id: z.string().uuid(), pid: z.number().int().positive() }).strict();
const stateSchema = z.object({ active: z.array(ticket).max(4), waiting: z.array(ticket).max(16) }).strict();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
/** Cross-worker FIFO, scoped to a workspace/project/connector identity. Dead
 * owners are reclaimed; a live owner is never evicted merely for taking time. */
export async function acquireMcpCall(cwd: string, connector: string, signal?: AbortSignal, queueTimeoutMs = 30_000) {
  signal?.throwIfAborted();
  const path = workspaceFile(cwd, `mcp-call-queues/${createHash("sha256").update(connector).digest("hex")}.json`);
  const id = randomUUID(), started = Date.now();
  let admitted = false;
  const update = async (fn: (state: z.infer<typeof stateSchema>) => void) => withFileWriteLock(path, async () => {
    const state = stateSchema.parse(await readJson(path, { active: [], waiting: [] }));
    state.active = state.active.filter((item) => alive(item.pid)); state.waiting = state.waiting.filter((item) => alive(item.pid));
    fn(state); await writeJsonAtomic(path, state);
  });
  const remove = () => update((state) => { state.active = state.active.filter((item) => item.id !== id); state.waiting = state.waiting.filter((item) => item.id !== id); });
  try {
    await update((state) => {
      signal?.throwIfAborted();
      if (state.waiting.length >= 16) throw new Error("MCP connector queue is full");
      state.waiting.push({ id, pid: process.pid });
    });
    for (;;) {
      signal?.throwIfAborted();
      if (Date.now() - started >= queueTimeoutMs) throw new Error("MCP connector queue wait timed out");
      await update((state) => {
        signal?.throwIfAborted();
        if (state.active.length < 4 && state.waiting[0]?.id === id) {
          state.waiting.shift(); state.active.push({ id, pid: process.pid }); admitted = true;
        }
      });
      if (admitted) break;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("MCP queue cancelled")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 40);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { signal.removeEventListener("abort", abort); abort(); }
      });
    }
    return { queuedMs: Date.now() - started, release: remove };
  } catch (error) { await remove(); throw error; }
}
