import { lookup } from "node:dns";
import { isIP } from "node:net";
import { EnvHttpProxyAgent, ProxyAgent, fetch as transportFetch } from "undici";
import { isPrivateOrReservedAddress, parseOutboundHttpUrl, validateConnectorOutboundUrl } from "../security/outbound-security.js";
import { egressAuditEnabled, recordEgress } from "../security/egress-audit.js";

// Check the actual connection lookup as well as the URL preflight, so a DNS
// answer cannot change to a private address between validation and connection.
// Environment proxies are operator-configured egress gateways. URL validation
// still runs before every request; the gateway owns connection-time DNS checks
// for tunneled destinations. Direct/NO_PROXY traffic retains the socket guard.
const publicDispatcher = new EnvHttpProxyAgent({ connect: {
  autoSelectFamily: false,
  lookup(hostname, options, callback) {
    lookup(hostname, options, (error, address, family) => {
      if (error) return callback(error, address, family);
      const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
      if (addresses.some(isPrivateOrReservedAddress)) return callback(new Error("MCP connection resolves to a private or reserved address"), address, family);
      callback(null, address, family);
    });
  },
} });

const privateDispatcher = new EnvHttpProxyAgent({ connect: { autoSelectFamily: false } });

// Set only by the trusted launcher, after removing connector-supplied values.
// The confined process cannot use host DNS. Its policy proxy resolves and checks
// destinations on the host, including private-address and rebinding protection.
// A forced ProxyAgent also prevents NO_PROXY from causing direct DNS lookups.
const sandboxProxy = process.env.PI_SCIENCE_SANDBOX_HTTP_PROXY;
const sandboxDispatcher = sandboxProxy ? new ProxyAgent(sandboxProxyUrl(sandboxProxy)) : undefined;
function sandboxProxyUrl(raw: string): string {
  const url = parseOutboundHttpUrl(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid sandbox HTTP proxy endpoint");
  }
  return url.href;
}

export interface McpFetchPolicy {
  connectorId: string;
  projectId?: string | null;
  endpoint?: string | null;
  allowPrivate: boolean;
  note?: string;
}

/** Shared by the probe and runtime transports, including SSE POST endpoints.
 * Reject redirects so fetch cannot forward credentials to an unchecked target.
 */
export function createMcpFetch(policy: McpFetchPolicy): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const audit = await egressAuditEnabled();
    try {
      // Credentials belong exclusively to the configured connector origin.
      if (!policy.endpoint || new URL(request.url).origin !== new URL(policy.endpoint).origin) {
        throw new Error("MCP cross-origin requests are blocked");
      }
      if (sandboxDispatcher) {
        const url = parseOutboundHttpUrl(request.url);
        // Literal IPs can be checked locally without DNS; domain resolution is
        // exclusively the policy proxy's responsibility in the sandbox.
        if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
          await validateConnectorOutboundUrl(request.url, { allowPrivate: policy.allowPrivate });
        }
      } else {
        await validateConnectorOutboundUrl(request.url, { allowPrivate: policy.allowPrivate });
      }
    } catch (error) {
      if (audit) await recordEgress({ connector_type: "mcp", connector_id: policy.connectorId, project_id: policy.projectId, target_domain: request.url, approved: false, note: "mcp_network_blocked" });
      throw error;
    }
    if (audit) await recordEgress({ connector_type: "mcp", connector_id: policy.connectorId, project_id: policy.projectId, target_domain: request.url, approved: true, note: policy.note ?? "mcp_runtime" });
    const response = await transportFetch(request.url, {
      method: request.method, headers: [...request.headers.entries()], body: request.body,
      signal: request.signal, redirect: "manual", duplex: "half",
      dispatcher: sandboxDispatcher ?? (policy.allowPrivate ? privateDispatcher : publicDispatcher),
    }).catch(async (error: unknown) => {
      if (audit) await recordEgress({ connector_type: "mcp", connector_id: policy.connectorId, project_id: policy.projectId, target_domain: request.url, approved: false, note: "mcp_connection_failed" });
      throw error;
    });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      await response.body?.cancel();
      throw new Error("MCP HTTP redirects are blocked; configure the final endpoint URL");
    }
    return response as unknown as Response;
  };
}
