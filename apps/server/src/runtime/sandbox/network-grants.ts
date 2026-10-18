import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { configRoot, withFileWriteLock, writeJsonAtomic } from "../../storage/persistence.js";
import { profileConfiguration } from "./profiles.js";
import { BUILTIN_DENIED_DOMAINS, networkDomain, networkGrantsSchema, networkRuleInput, readNetworkGrantFile, type NetworkGrantProfile } from "./network-grant-state.js";
export * from "./network-grant-state.js";

export function networkGrantsPath() {
  const directory = join(realpathSync(configRoot()), "network-permissions");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory || process.platform !== "win32" && ((info.mode & 0o022) || info.uid !== process.getuid!())) throw new Error("Network permissions require a private service-owned directory");
  return join(directory, "grants.json");
}
export const readNetworkGrants = (path = networkGrantsPath()) => readNetworkGrantFile(path);
export function domainMatches(domain: string, pattern: string): boolean {
  const host = pattern.split(":")[0]!.toLowerCase();
  return host === domain || host.startsWith("*.") && domain.endsWith(host.slice(1));
}
export async function assertGrantable(profile: NetworkGrantProfile, domain: string) {
  networkDomain.parse(domain);
  const config = await profileConfiguration();
  if ([...BUILTIN_DENIED_DOMAINS, ...(config.profiles[profile]?.deniedDomains ?? [])].some((pattern) => domainMatches(domain, pattern))) throw new Error("Domain is blocked by the operator network policy");
}
/** Service-owned durable decisions. Revision fencing prevents a pending approval
 * from overwriting a newer denial/revocation recorded in Settings. */
export async function changeNetworkGrant(input: z.infer<typeof networkRuleInput>, source: "settings" | "approval", expectedRevision?: number, reason?: string) {
  const value = networkRuleInput.parse(input);
  if (value.decision === "allow") await assertGrantable(value.profile, value.domain);
  const path = networkGrantsPath();
  return withFileWriteLock(path, async () => {
    const state = await readNetworkGrants(path);
    if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new Error("Network permissions changed while approval was pending; request access again");
    state.rules = state.rules.filter((rule) => rule.profile !== value.profile || rule.domain !== value.domain);
    state.rules.push({ ...value, source, createdAt: new Date().toISOString(), ...(reason ? { reason: reason.slice(0, 2000) } : {}) });
    state.revision++;
    networkGrantsSchema.parse(state);
    if (Buffer.byteLength(JSON.stringify(state, null, 2)) > 2 * 1024 * 1024) throw new Error("Network permission ledger is full; remove unused permissions first");
    await writeJsonAtomic(path, state, { mode: 0o600 });
    return state;
  });
}
export async function revokeNetworkGrant(profile: NetworkGrantProfile, domain: string) {
  const path = networkGrantsPath();
  return withFileWriteLock(path, async () => {
    const state = await readNetworkGrants(path);
    state.rules = state.rules.filter((rule) => rule.profile !== profile || rule.domain !== domain);
    state.revision++;
    await writeJsonAtomic(path, state, { mode: 0o600 });
    return state;
  });
}
