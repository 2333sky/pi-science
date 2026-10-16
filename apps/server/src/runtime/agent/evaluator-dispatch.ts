import { EvaluatorRegistry } from "../evaluation/evaluator-registry.js";
import { EvaluatorService } from "../evaluation/evaluator-service.js";
import { authenticateEvaluatorParent } from "../evaluation/evaluator-identity.js";
import { safeEvaluationError } from "../evaluation/evaluator-runner.js";
import type { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { AgentRuntimeStartOptions } from "./worker/protocol.js";
import type { RuntimeEvent } from "./agent-runtime-types.js";

/** Listener is attached to the authenticated Worker connection by its server owner.
 * Request bodies never choose caller/session/role/research/filesystem identity. */
export function bindEvaluatorDispatch(runtime: AgentCoreRuntimeClient, options: AgentRuntimeStartOptions): () => Promise<void> {
  const pending = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  runtime.once("exit", () => { for (const entry of pending.values()) entry.controller.abort(); });
  runtime.on("event", (event: RuntimeEvent) => {
    const id = String(event.id ?? "");
    if (event.type === "evaluation.cancelled") { pending.get(id)?.controller.abort(); return; }
    if (event.type !== "evaluation.requested" || pending.has(id)) return;
    const controller = new AbortController();
    const run = async () => {
      if (options.parentSessionId !== undefined || options.delegatedAgent !== undefined || !process.env.PI_SCIENCE_EVALUATOR_ROOT) throw new Error("trusted evaluator unavailable");
      const authenticate = async () => {
        const state = await runtime.sendCommand("get_state");
        if (runtime.isClosed || !state.success || !state.data || state.data.operation?.id !== event.operationId || !state.data.activeTools.includes("evaluate_candidate")) throw new Error("Evaluation caller is not authorized");
        return authenticateEvaluatorParent(options.cwd, runtime.sessionId, String(event.operationId));
      };
      const service = new EvaluatorService(new EvaluatorRegistry(process.env.PI_SCIENCE_EVALUATOR_ROOT, [options.cwd]));
      const response = await service.evaluate(authenticate, String(event.invocationId), event.params, controller.signal);
      return { content: [{ type: "text", text: JSON.stringify(response) }], details: response };
    };
    const promise = run().then((data) => runtime.sendNotification("evaluation_response", { id, result: { success: true, data } }),
      (error) => runtime.sendNotification("evaluation_response", { id, result: { success: false, error: `trusted evaluator unavailable: ${safeEvaluationError(error)}` } })).catch(() => undefined).finally(() => pending.delete(id));
    pending.set(id, { controller, promise });
  });
  return async () => { while (pending.size) await Promise.allSettled([...pending.values()].map((entry) => entry.promise)); };
}
