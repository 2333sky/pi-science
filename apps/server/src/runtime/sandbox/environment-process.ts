import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { applySandboxProfile } from "./profiles.js";
import { canonicalDirectory, identifyPolicy, isWithin, operatorExecutionMode } from "./policy.js";
import { killSandboxGroup, launcherPath, prepareSandbox, type PreparedSandbox } from "./process.js";

/** Installers receive a new revision prefix and package cache, never workspaces,
 * credentials, the service state root or any previously published environment. */
export async function runEnvironmentProcess(
  command: string,
  args: string[],
  prefix: string,
  cache: string | undefined,
  timeoutMs: number,
  environment: Record<string, string> = {},
  options: {
    requireSandbox?: boolean;
    restrictNetworkTo?: readonly string[];
    signal?: AbortSignal;
    stdout?: (output: string) => void;
  } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  await mkdir(prefix, { recursive: true });
  prefix = await canonicalDirectory(await realpath(prefix));
  if (cache) {
    await mkdir(cache, { recursive: true });
    cache = await canonicalDirectory(await realpath(cache));
  }
  const mode = options.requireSandbox ? "required" : operatorExecutionMode();
  const executable = await realpath(
    isAbsolute(command)
      ? command
      : (
          await promisify(execFile)("/usr/bin/which", [command], {
            env: { PATH: process.env.PATH },
            timeout: 5000,
          })
        ).stdout.trim(),
  );
  let prepared: PreparedSandbox | undefined;
  let installerCwd: string | undefined;
  try {
    if (mode === "required") {
      // Linux isolation adds mandatory protected-file placeholders to cwd.
      // Keep these out of the new prefix: package managers require an empty
      // target or an existing conda environment, not arbitrary dotfiles.
      if (cache) installerCwd = await mkdtemp(join(cache, ".installer-"));
      let policy = await applySandboxProfile(
        identifyPolicy({
          mode,
          scope: "workspace",
          cwd: installerCwd ?? prefix,
          readPaths: [prefix, ...(cache ? [cache] : [])],
          writePaths: cache ? [prefix, cache] : [],
          denyPaths: [],
          network: { mode: "none" },
        }),
        cache ? "install" : "control",
      );
      const restrictedDomains = options.restrictNetworkTo;
      if (restrictedDomains) {
        const network = policy.network;
        const allowedDomains =
          network.mode === "allowlist"
            ? network.allowedDomains.filter((domain) => restrictedDomains.includes(domain))
            : [];
        policy = identifyPolicy({
          ...policy,
          network:
            allowedDomains.length && network.mode === "allowlist"
              ? { ...network, allowedDomains }
              : { mode: "none" },
        });
      }
      // A health check reads the installed prefix. The install executable must
      // be outside its writable target; package scripts remain inside it.
      if (cache && [prefix, cache].some((root) => isWithin(root, executable)))
        throw new Error("Installer executable overlaps writable environment paths");
      prepared = await prepareSandbox(
        policy,
        [executable, ...args],
        [...new Set([executable, ...(!cache ? [prefix] : [])])],
        Math.ceil(timeoutMs / 1000),
        undefined,
        undefined,
        environment,
      );
    }
    options.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        prepared ? process.execPath : executable,
        prepared ? [launcherPath, prepared.manifest] : args,
        {
          cwd: installerCwd ?? prefix,
          env: prepared?.env ?? environment,
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let stdout = "",
        output = "",
        timedOut = false,
        overflow = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killSandboxGroup(child.pid);
      }, timeoutMs);
      for (const stream of [child.stdout!, child.stderr!])
        stream.on("data", (chunk: Buffer) => {
          if (Buffer.byteLength(output) + chunk.length > 1024 * 1024) {
            overflow = true;
            killSandboxGroup(child.pid);
          } else {
            const value = chunk.toString("utf8");
            output += value;
            if (options.stdout && stream === child.stdout) stdout += value;
          }
        });
      const abort = () => killSandboxGroup(child.pid);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      child.once("error", (error) => {
        cleanup();
        killSandboxGroup(child.pid);
        reject(error);
      });
      child.once("close", (code) => {
        cleanup();
        killSandboxGroup(child.pid);
        if (options.signal?.aborted) reject(options.signal.reason);
        else if (timedOut || overflow || code !== 0)
          reject(
            new Error(
              timedOut
                ? `Environment operation timed out after ${timeoutMs}ms`
                : overflow
                  ? "Environment operation exceeded its output limit"
                  : `Environment operation failed: ${output || `exit ${code}`}`,
            ),
          );
        else {
          try {
            options.stdout?.(stdout);
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  } finally {
    try {
      await prepared?.cleanup();
    } finally {
      if (installerCwd) await rm(installerCwd, { recursive: true, force: true });
    }
  }
}
