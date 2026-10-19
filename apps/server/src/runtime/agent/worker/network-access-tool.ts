import { sessionMode } from "../../sandbox/session-approval.js";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { assertGrantable, changeNetworkGrant, domainMatches, networkDomain, networkGrantProfile, networkGrantTargetKey, readNetworkGrants } from "../../sandbox/network-grants.js";
import { profileConfiguration } from "../../sandbox/profiles.js";
import type { InteractionBridge } from "./interaction-bridge.js";

export function networkAccessTool(bridge: InteractionBridge, cwd?: string, sessionId?: string): AgentHarnessTool<{ env: NodeExecutionEnv }> {
  return {
    name: "request_network_access", label: "Request network access",
    description: "Ask the user to permanently allow a public hostname over HTTPS/443 for analysis (Bash, Python and Jobs) or local MCP. Grants apply across projects until revoked in Network settings. Denied/private destinations cannot be bypassed. Approval updates running proxies without restarting kernels; retry the blocked request afterwards. Use profile=mcp for MCP tools; analysis grants do not authorize MCP connections. Candidate, install, control and BYOC policies are separate.",
    parameters: Type.Object({ domain: Type.String(), profile: Type.Optional(Type.Union([Type.Literal("analysis"), Type.Literal("mcp")])), reason: Type.Optional(Type.String({ maxLength: 2000 })) }),
    async execute(_id, params, _update, _ctx, _invocation, context) {
      const { domain, profile, reason } = z.object({ domain: networkDomain, profile: networkGrantProfile.default("analysis"), reason: z.string().max(2000).optional() }).strict().parse(params);
      const result = (status: string, message: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ status, message }) }], details: { status, domain, profile } });
      await assertGrantable(profile, domain);
      const before = await readNetworkGrants();
      const decision = before.rules.find((rule) => rule.profile === profile && rule.domain === domain)?.decision;
      if (decision === "deny") return result("denied", "A standing denial blocks this domain. The user can change it in Network settings.");
      if (cwd && await sessionMode(cwd, sessionId) !== "ask") return result("session_allowed", "Public HTTPS access is permitted by this session mode; existing denials still apply.");
      const config = await profileConfiguration();
      if (decision === "allow" || config.profiles[profile]?.allowedDomains.some((pattern) => (!pattern.includes(":") || pattern.endsWith(":443")) && domainMatches(domain, pattern))) return result("already_allowed", "This hostname is already allowed over HTTPS/443.");
      _update({ content: [], details: { approval: "waiting" } });
      const answer = await bridge.request(`Network access: ${domain}`, "", context.abortSignal, {
        toolCallId: _id, method: "select", kind: "permission", message: `${reason ? `${reason}\n\n` : ""}Allow ${domain} over HTTPS (port 443) for ${profile} across all projects? This persists until revoked in Settings → Network.`,
        options: [{ label: "Always allow", value: "allow" }, { label: "Deny this request", value: "deny_once" }, { label: "Never allow", value: "deny" }],
      });
      _update({ content: [], details: { approval: "resolved" } });
      context.abortSignal?.throwIfAborted();
      if (answer !== "allow" && answer !== "deny") return result("denied", "Network access was not granted.");
      await changeNetworkGrant({ domain, profile, decision: answer }, "approval", { targetRevision: before.targetRevisions[networkGrantTargetKey(profile, domain)] ?? 0 }, reason);
      return result(answer === "allow" ? "granted" : "denied", answer === "allow" ? "Access granted. Retry the blocked request; kernel state is preserved." : "A standing denial was saved.");
    },
  };
}
