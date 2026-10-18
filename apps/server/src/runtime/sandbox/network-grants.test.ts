import { mkdtemp, mkdir, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { changeNetworkGrant, grantedNetwork, networkDomain, networkGrantsPath, networkGrantSource, readNetworkGrants, revokeNetworkGrant } from "./network-grants.js";
import { workspacePolicy } from "./policy.js";
import { domainAllowed } from "./network.js";
import { prepareSandbox } from "./process.js";
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "network-grants-"))); vi.stubEnv("PI_SCIENCE_HOME", root); vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", ""); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it("persists concurrent decisions, isolates roles and restores the same allowance on reread", async () => {
  await Promise.all([changeNetworkGrant({ profile: "analysis", domain: "api.example.org", decision: "allow" }, "settings"), changeNetworkGrant({ profile: "mcp", domain: "mcp.example.org", decision: "allow" }, "approval")]);
  const state = await readNetworkGrants();
  expect(state.revision).toBe(2); expect(state.rules).toHaveLength(2);
  const analysis = grantedNetwork({ mode: "none" }, state, "analysis");
  expect(domainAllowed("api.example.org", 443, analysis)).toBe(true);
  expect(domainAllowed("api.example.org", 80, analysis)).toBe(false);
  expect(domainAllowed("mcp.example.org", 443, analysis)).toBe(false);
  await revokeNetworkGrant("analysis", "api.example.org");
  expect(domainAllowed("api.example.org", 443, grantedNetwork({ mode: "none" }, await readNetworkGrants(), "analysis"))).toBe(false);
});
it("fences a pending approval against newer revocations and denials", async () => {
  const initial = await readNetworkGrants();
  await changeNetworkGrant({ profile: "analysis", domain: "api.example.org", decision: "deny" }, "settings");
  await expect(changeNetworkGrant({ profile: "analysis", domain: "api.example.org", decision: "allow" }, "approval", initial.revision)).rejects.toThrow("changed while approval");
  expect((await readNetworkGrants()).rules[0]?.decision).toBe("deny");
});
it.each(["analysis", "mcp"] as const)("rejects %s permissions inside a writable sandbox workspace", async (profile) => {
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
  const workspace = join(root, "workspace"); await mkdir(workspace);
  vi.stubEnv("PI_SCIENCE_HOME", join(workspace, ".test-settings"));
  const policy = await workspacePolicy(workspace, undefined, profile);
  await expect(prepareSandbox(policy, ["true"], [], 1)).rejects.toThrow("Network permissions must be outside writable sandbox paths");
});
it.each(["analysis", "mcp"] as const)("allows %s HTTPS approval when an operator deny applies only to port 80", async (profile) => {
  const config = join(root, "profiles.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, profiles: { [profile]: { deniedDomains: ["api.example.org:80", "*.example.org:80"] } } }), { mode: 0o600 });
  vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", config);
  await changeNetworkGrant({ profile, domain: "api.example.org", decision: "allow" }, "approval");
  const network = grantedNetwork({ mode: "allowlist", allowedDomains: [], deniedDomains: ["api.example.org:80", "*.example.org:80"] }, await readNetworkGrants(), profile);
  expect(domainAllowed("api.example.org", 443, network)).toBe(true);
  expect(domainAllowed("api.example.org", 80, network)).toBe(false);
  for (const deny of ["api.example.org:443", "*.example.org:443", "api.example.org", "*.example.org"]) {
    await writeFile(config, JSON.stringify({ schemaVersion: 1, profiles: { [profile]: { deniedDomains: [deny] } } }), { mode: 0o600 });
    await expect(changeNetworkGrant({ profile, domain: "api.example.org", decision: "allow" }, "settings")).rejects.toThrow("operator");
  }
});
it("denies override static allows and built-in/operator denials cannot be approved", async () => {
  await expect(changeNetworkGrant({ profile: "analysis", domain: "pastebin.com", decision: "allow" }, "settings")).rejects.toThrow("operator");
  const config = join(root, "profiles.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, profiles: { analysis: { deniedDomains: ["*.example.org"] } } }), { mode: 0o600 });
  vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", config);
  await expect(changeNetworkGrant({ profile: "analysis", domain: "api.example.org", decision: "allow" }, "approval")).rejects.toThrow("operator");
  await changeNetworkGrant({ profile: "analysis", domain: "api.example.org", decision: "deny" }, "settings");
  expect(domainAllowed("api.example.org", 443, grantedNetwork({ mode: "allowlist", allowedDomains: ["*.example.org:443"], deniedDomains: [] }, await readNetworkGrants(), "analysis"))).toBe(false);
});
it.each(["https://example.org/a", "example.org:8443", "*.example.org", "localhost", "service.internal", "service.localhost", "127.0.0.1", "0x7f.0.0.1", "example.org/path", "example..org"])("refuses malformed/private network targets: %s", (domain) => { expect(networkDomain.safeParse(domain).success).toBe(false); });
it("fails closed on corruption, untrusted file permissions and a deleted decision ledger", async () => {
  await changeNetworkGrant({ profile: "analysis", domain: "api.example.org", decision: "allow" }, "settings");
  const source = networkGrantSource({ mode: "none" }, networkGrantsPath(), "analysis");
  expect(domainAllowed("api.example.org", 443, await source())).toBe(true);
  await writeFile(networkGrantsPath(), "broken", { mode: 0o600 });
  await expect(readNetworkGrants()).rejects.toThrow();
  await expect(source()).rejects.toThrow();
  await rm(networkGrantsPath());
  await expect(source()).rejects.toThrow("removed or rolled back");
  if (process.platform !== "win32") {
    await changeNetworkGrant({ profile: "analysis", domain: "api.example.org", decision: "allow" }, "settings");
    await chmod(networkGrantsPath(), 0o644); await expect(readNetworkGrants()).rejects.toThrow("private");
  }
});

it("keeps an operator deny effective against a saved user grant even when its static allowlist is empty", async () => {
  await changeNetworkGrant({ profile: "analysis", domain: "api.example.org", decision: "allow" }, "settings");
  const config = join(root, "profiles.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, profiles: { analysis: { allowedDomains: [], deniedDomains: ["api.example.org"] } } }), { mode: 0o600 });
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", config);
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const policy = await workspacePolicy(workspace);
  expect(domainAllowed("api.example.org", 443, grantedNetwork(policy.network, await readNetworkGrants(), "analysis"))).toBe(false);
});
