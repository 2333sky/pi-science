import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { evaluateCandidateRequestSchema } from "../../evaluation/evaluator-contracts.js";
import { SubagentBridge } from "./subagent-tool.js";

export function evaluateCandidateTool(bridge: SubagentBridge): AgentHarnessTool<{ env: NodeExecutionEnv }> {
  return { name: "evaluate_candidate", label: "Evaluate candidate", description: "Request an independent score for an immutable candidate data artifact using an operator-approved frozen evaluator. Parent only; requires a bound research execution budget. No code, commands, paths, dataset selection or approval can be supplied. Missing setup reports trusted evaluator unavailable; never substitute self-reported scores.",
    parameters: Type.Object({ evaluator_revision_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" }), artifact_id: Type.String(), artifact_version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
    async execute(_id, params, _update, _ctx, invocation, context) {
      evaluateCandidateRequestSchema.parse(params);
      const response = await bridge.request({ params, operationId: invocation.operationId, invocationId: invocation.invocationId }, context.abortSignal, "evaluation.requested");
      if (!response.success) throw new Error(response.error ?? "trusted evaluator unavailable");
      return response.data as { content: Array<{ type: "text"; text: string }>; details: unknown };
    },
  };
}
