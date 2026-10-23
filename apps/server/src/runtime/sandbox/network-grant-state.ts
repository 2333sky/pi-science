import { isIP } from "node:net";
import { z } from "zod";
import type { SandboxPolicy } from "./policy.js";

export const BUILTIN_DENIED_DOMAINS = ["pastebin.com", "*.pastebin.com", "webhook.site", "*.webhook.site", "api.telegram.org", "hooks.slack.com", "metadata.google.internal"];
export const networkGrantProfile = z.enum(["analysis", "mcp"]);
export type NetworkGrantProfile = z.infer<typeof networkGrantProfile>;
/** Exact RFC1918 IPv4 endpoints. Missing ports retain the HTTPS default of 443. */
export function privateNetworkTarget(value: string): { host: string; port: number } | undefined {
  const match = /^(\d+\.\d+\.\d+\.\d+)(?::([1-9]\d{0,4}))?$/.exec(value);
  if (!match || isIP(match[1]!) !== 4) return undefined;
  const host = match[1]!, [first, second] = host.split(".").map(Number);
  const port = Number(match[2] ?? 443);
  if (port > 65535 || !(first === 10 || first === 172 && second! >= 16 && second! <= 31 || first === 192 && second === 168)) return undefined;
  return { host, port };
}
export const networkDomain = z.string().trim().toLowerCase().max(253).refine((domain) => {
  if (privateNetworkTarget(domain)) return true;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) return false;
  if (/^[\d.]+$/.test(domain) || domain.split(".").every((part) => /^(?:0x[0-9a-f]+|\d+)$/i.test(part))) return false;
  return !["localhost", "local", "internal", "localdomain", "home.arpa"].some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`));
}, "Enter a public hostname or RFC1918 IPv4 address with an optional port; no scheme, path or wildcard");
const rule = z.object({ profile: networkGrantProfile, domain: networkDomain, decision: z.enum(["allow", "deny"]), createdAt: z.string().datetime(), source: z.enum(["settings", "approval"]), reason: z.string().max(2000).optional() }).strict();
export const networkGrantsSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), rules: z.array(rule).max(512), targetRevisions: z.record(z.string(), z.number().int().nonnegative()).default({}) }).strict();
export type NetworkGrants = z.infer<typeof networkGrantsSchema>;
export const networkRuleInput = rule.pick({ profile: true, domain: true, decision: true });

export const emptyNetworkGrants = (): NetworkGrants => ({ schemaVersion: 1, revision: 0, rules: [], targetRevisions: {} });
export async function readNetworkGrantFile(path: string): Promise<NetworkGrants> {
  // Launchers run as plain Node TypeScript in development, without a TS loader.
  const { readOperatorConfig } = await import(new URL(import.meta.url.endsWith(".ts") ? "./operator-config.ts" : "./operator-config.js", import.meta.url).href) as typeof import("./operator-config.js");
  try { return networkGrantsSchema.parse(await readOperatorConfig(path, 2 * 1024 * 1024)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyNetworkGrants(); throw error; }
}

export function grantedNetwork(base: SandboxPolicy["network"], state: NetworkGrants, profile: NetworkGrantProfile): SandboxPolicy["network"] {
  const rules = state.rules.filter((rule) => rule.profile === profile);
  const allowedDomains = base.mode === "allowlist" ? base.allowedDomains : [];
  // Public hostname approvals remain HTTPS-only. Exact private endpoints permit
  // HTTP and TLS on the approved port for local research services.
  const privateAllows = rules.filter((rule) => rule.decision === "allow").flatMap((rule) => {
    const target = privateNetworkTarget(rule.domain);
    return target ? [`${target.host}:${target.port}`] : [];
  });
  const httpsOnlyDomains = [...new Set([...(base.mode === "allowlist" ? base.httpsOnlyDomains ?? [] : []), ...rules.filter((rule) => rule.decision === "allow" && !privateNetworkTarget(rule.domain)).map((rule) => `${rule.domain}:443`)])];
  const deniedDomains = [...new Set([...BUILTIN_DENIED_DOMAINS, ...(base.mode === "allowlist" ? base.deniedDomains : []), ...rules.filter((rule) => rule.decision === "deny").map((rule) => rule.domain)])];
  return { mode: "allowlist", allowedDomains: [...new Set([...allowedDomains, ...privateAllows])], httpsOnlyDomains, deniedDomains };
}


/** A running launcher never accepts a deleted or rolled-back decision ledger. */
export function networkGrantSource(base: SandboxPolicy["network"], path: string, profile: NetworkGrantProfile) {
  let revision = 0;
  return async () => {
    const state = await readNetworkGrantFile(path);
    if (state.revision < revision) throw new Error("Network permission state was removed or rolled back");
    revision = state.revision;
    return grantedNetwork(base, state, profile);
  };
}

/** Retain target revisions after revocation to detect allow/revoke cycles. */
export const networkGrantTargetKey = (profile: NetworkGrantProfile, domain: string) => JSON.stringify([profile, domain]);
