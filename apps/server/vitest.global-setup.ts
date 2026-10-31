import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = dirname(fileURLToPath(new URL("./package.json", import.meta.url)));

/** The worker's file tool derives the trusted installation root with
 *  `new URL("../../../../", import.meta.url)`, so the precompiled entry has to
 *  sit exactly four directories below `apps/server` for that check to keep
 *  seeing `apps/server` as the installation. Putting it under `node_modules`
 *  keeps `src` free of build output, and teardown removes it again. */
export const workerBundle = join(serverRoot, "node_modules", ".cache", "pi-science-worker", "entry", "main.mjs");

export async function setup(): Promise<void> {
  await mkdir(dirname(workerBundle), { recursive: true });
  await build({
    entryPoints: [join(serverRoot, "src", "runtime", "agent", "worker", "main.ts")],
    outfile: workerBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
}

export async function teardown(): Promise<void> {
  await rm(join(serverRoot, "node_modules", ".cache", "pi-science-worker"), { recursive: true, force: true });
}
