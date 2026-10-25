import Fastify from "fastify";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFileReadRoutes } from "./file-routes.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-folder-mgmt-"));
  workspaces.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  return cwd;
}

async function buildApp(cwd: string) {
  const app = Fastify({ logger: false });
  registerFileReadRoutes(app as never);
  apps.push(app);
  const query = `cwd=${encodeURIComponent(cwd)}`;
  return { app, query };
}

describe("POST /api/files/mkdir", () => {
  it("creates nested folders and records provenance", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    const response = await app.inject({ method: "POST", url: `/api/files/mkdir?${query}`, payload: { path: "figures/final" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, path: "figures/final" });
    expect((await stat(join(cwd, "figures", "final"))).isDirectory()).toBe(true);
  });

  it("rejects empty and escaping paths", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    expect((await app.inject({ method: "POST", url: `/api/files/mkdir?${query}`, payload: { path: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/files/mkdir?${query}`, payload: { path: "../escape" } })).statusCode).toBe(400);
  });
});

describe("DELETE /api/files/*", () => {
  it("refuses to delete the workspace root and .pi-science", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    // Whether the guard answers 403 (explicit refusal) or 404 (the sensitive-path
    // policy rejects resolution first), the directories must survive.
    const rootStatus = (await app.inject({ method: "DELETE", url: `/api/files/.?${query}&recursive=true` })).statusCode;
    expect([403, 404]).toContain(rootStatus);
    const metaStatus = (await app.inject({ method: "DELETE", url: `/api/files/.pi-science?${query}&recursive=true` })).statusCode;
    expect([403, 404]).toContain(metaStatus);
    expect((await stat(join(cwd, ".pi-science"))).isDirectory()).toBe(true);
  });

  it("requires explicit recursive for non-empty folders and then removes the subtree", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    await mkdir(join(cwd, "runs", "old"), { recursive: true });
    await writeFile(join(cwd, "runs", "old", "a.txt"), "x", "utf8");

    const guarded = await app.inject({ method: "DELETE", url: `/api/files/runs?${query}` });
    expect(guarded.statusCode).toBe(409);
    expect(guarded.json()).toMatchObject({ error: expect.stringContaining("recursive=true") });

    const removed = await app.inject({ method: "DELETE", url: `/api/files/runs?${query}&recursive=true` });
    expect(removed.statusCode).toBe(200);
    await expect(stat(join(cwd, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("POST /api/files/reveal", () => {
  it("dispatches the platform file manager without waiting on the child process", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    await mkdir(join(cwd, "figures"), { recursive: true });
    const response = await app.inject({ method: "POST", url: `/api/files/reveal?${query}`, payload: { path: "figures" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, path: "figures", is_directory: true });
  });

  it("validates the path stays inside the workspace", async () => {
    const cwd = await makeWorkspace();
    const { app, query } = await buildApp(cwd);
    const response = await app.inject({ method: "POST", url: `/api/files/reveal?${query}`, payload: { path: "../../etc" } });
    expect(response.statusCode).toBe(400);
  });
});
