import Fastify from "fastify";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { registerSettingsRoutes } from "./settings-routes.js";
import { SettingsStore } from "../../storage/settings-store.js";
import { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { readSessionApproval, saveSessionApproval } from "../../runtime/sandbox/session-approval.js";
import { defaultSessionApproval } from "../../runtime/sandbox/approval-preferences.js";

it("saves a separate ask/auto default without changing existing sessions or restarting runtimes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-preferences-"));
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "private"));
  await mkdir(join(cwd, ".pi-science"));
  const settings = new SettingsStore(); const reload = vi.fn();
  const app = Fastify(); registerSettingsRoutes(app, { reloadConfiguration: reload } as never, settings);
  try {
    expect((await app.inject({ method: "GET", url: "/api/settings/approval" })).json()).toEqual({ defaultMode: "ask" });
    await saveSessionApproval(cwd, "history", "full", 0);
    expect((await app.inject({ method: "PUT", url: "/api/settings/approval", payload: { defaultMode: "full" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/settings/approval", payload: { defaultMode: "auto" } })).json()).toEqual({ defaultMode: "auto" });
    expect(await defaultSessionApproval()).toEqual({ mode: "auto" });
    expect(await readSessionApproval(cwd, "history")).toEqual({ mode: "full", revision: 1 });
    const service = new NodeSessionService();
    const core = (service as unknown as { agentCore: { create: (...args: unknown[]) => Promise<{ id: string }> } }).agentCore;
    const create = vi.spyOn(core, "create").mockResolvedValue({ id: "new" });
    await service.create({ cwd, config: { skills: [], extensions: [] } });
    expect(create.mock.calls.at(-1)?.[2]).toEqual({ mode: "auto" });
    await service.create({ cwd, config: { skills: [], extensions: [] }, initialApproval: { mode: "ask" } });
    expect(create.mock.calls.at(-1)?.[2]).toEqual({ mode: "ask" });
    expect(reload).not.toHaveBeenCalled();
    const metrics = await app.inject({ method: "GET", url: "/api/settings/approval-metrics" });
    expect(metrics.json()).toMatchObject({ window: 1000, transitions: [] });
    expect(JSON.stringify(metrics.json())).not.toContain(cwd);
    await settings.update((config) => { config.approval_preferences = { defaultMode: "full" } as never; });
    expect(await defaultSessionApproval()).toEqual({ mode: "ask" });
  } finally { await app.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(cwd, { recursive: true, force: true }); }
});
