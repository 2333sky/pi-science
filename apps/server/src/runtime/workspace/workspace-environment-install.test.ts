import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { WorkspaceEnvironmentService } from "./workspace-environment.js";
import { runEnvironmentProcess } from "../sandbox/environment-process.js";
vi.mock("../sandbox/environment-process.js", () => ({ runEnvironmentProcess: vi.fn() }));

it("creates a canonical package-manager root inside the granted cache before entering the installer sandbox", async () => {
  // tmpdir may use the OS alias (/var on macOS), as real application homes do.
  const home = await mkdtemp(join(tmpdir(), "pi-science-install-path-"));
  vi.stubEnv("PI_SCIENCE_HOME", home);
  const service = new WorkspaceEnvironmentService();
  (service as unknown as { ensureMicromamba: () => Promise<string> }).ensureMicromamba = async () => process.execPath;
  vi.mocked(runEnvironmentProcess).mockImplementation(async (_command, args, prefix, cache, _timeout, env) => {
    expect(prefix).toBe(await realpath(prefix));
    expect(args[args.indexOf("--prefix") + 1]).toBe(prefix);
    expect(cache).toBe(await realpath(cache!));
    expect(env?.MAMBA_ROOT_PREFIX).toBe(join(cache!, "root"));
    expect(env?.CONDA_PKGS_DIRS).toBe(cache);
    expect((await stat(env!.MAMBA_ROOT_PREFIX!)).isDirectory()).toBe(true);
    throw new Error("Installer boundary checked");
  });
  try {
    await expect(service.create({ name: "test", packages: ["python=3.12"] })).rejects.toThrow("Installer boundary checked");
    expect(runEnvironmentProcess).toHaveBeenCalledOnce();
  } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
});
