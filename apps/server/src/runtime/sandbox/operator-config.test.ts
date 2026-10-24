import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readOperatorConfig } from "./operator-config.js";
import { configRoot } from "../../storage/persistence.js";
import { readSessionApproval, saveSessionApproval } from "./session-approval.js";

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "operator-config-"))); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it.skipIf(process.platform === "win32")("creates private application state that can persist approval modes", async () => {
  vi.stubEnv("PI_SCIENCE_HOME", join(root, "new-state"));
  const { stat } = await import("node:fs/promises");
  expect((await stat(configRoot())).mode & 0o777).toBe(0o700);
  await saveSessionApproval(root, "session", "auto", 0);
  expect(await readSessionApproval(root, "session")).toEqual({ mode: "auto", revision: 1 });
});

it.skipIf(process.platform === "win32")("identifies the writable ancestor even when the immediate parent is private", async () => {
  const shared = join(root, "shared");
  const privateDir = join(shared, "private");
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  await chmod(shared, 0o775);
  const file = join(privateDir, "config.json");
  await writeFile(file, '{"schemaVersion":1}', { mode: 0o600 });
  await expect(readOperatorConfig(file)).rejects.toThrow(`writable ancestor: ${shared} (mode 775)`);
  await chmod(shared, 0o755);
  expect(await readOperatorConfig(file)).toEqual({ schemaVersion: 1 });
  await chmod(file, 0o644);
  await expect(readOperatorConfig(file)).rejects.toThrow("private single-link regular file");
});
