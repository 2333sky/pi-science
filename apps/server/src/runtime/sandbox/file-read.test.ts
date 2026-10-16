import { mkdir, mkdtemp, writeFile, link, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readRegularFile } from "./file-read.js";
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it.skipIf(process.platform !== "linux")("reads bounded regular bytes and refuses hardlinks, aliases and linked parents", async () => {
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "regular-read-"));
  const file = join(root, "file.txt"); await writeFile(file, "safe"); expect((await readRegularFile(file, 4)).toString()).toBe("safe");
  await expect(readRegularFile(file, 3)).rejects.toThrow("bounded"); await symlink(file, join(root, "alias")); await expect(readRegularFile(join(root, "alias"), 4)).rejects.toThrow();
  await symlink(root, join(root, "parent")); await expect(readRegularFile(join(root, "parent/file.txt"), 4)).rejects.toThrow();
  await link(file, join(root, "hard")); await expect(readRegularFile(file, 4)).rejects.toThrow("single-link");
});
