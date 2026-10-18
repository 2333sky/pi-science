import Fastify from "fastify";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerNetworkGrantRoutes } from "./network-grant-routes.js";
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "network-api-"))); vi.stubEnv("PI_SCIENCE_HOME", root); vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", ""); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it("lists, grants, blocks and revokes persistent role-scoped domain decisions", async () => {
  const app = Fastify(); registerNetworkGrantRoutes(app);
  try {
    const initial = await app.inject({ method: "GET", url: "/api/settings/network" });
    expect(initial.json()).toMatchObject({ revision: 0, rules: [], profiles: { analysis: { allowedDomains: [] } } });
    for (const decision of ["allow", "deny"]) {
      expect((await app.inject({ method: "POST", url: "/api/settings/network", payload: { profile: "analysis", domain: "API.Example.org", decision } })).statusCode).toBe(200);
      const state = (await app.inject({ method: "GET", url: "/api/settings/network" })).json();
      expect(state.rules).toMatchObject([{ profile: "analysis", domain: "api.example.org", decision, source: "settings" }]);
    }
    expect((await app.inject({ method: "DELETE", url: "/api/settings/network", payload: { profile: "analysis", domain: "api.example.org" } })).json()).toMatchObject({ rules: [], revision: 3 });
  } finally { await app.close(); }
});
it.each([
  { profile: "candidate", domain: "example.org", decision: "allow" },
  { profile: "install", domain: "example.org", decision: "allow" },
  { profile: "analysis", domain: "pastebin.com", decision: "allow" },
  { profile: "analysis", domain: "localhost", decision: "allow" },
  { profile: "analysis", domain: "*.example.org", decision: "allow" },
  { profile: "analysis", domain: "example.org", decision: "allow", source: "approval" },
])("rejects unsafe targets and caller-supplied authority: %j", async (payload) => {
  const app = Fastify(); registerNetworkGrantRoutes(app);
  try { expect((await app.inject({ method: "POST", url: "/api/settings/network", payload })).statusCode).toBe(400); }
  finally { await app.close(); }
});
