import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { isWithin } from "../runtime/sandbox/policy.js";

/** Resolve only the operator PATH, never connector/workspace PATH overrides. */
export async function resolveMcpExecutable(command: string, workspace: string, operatorPath = process.env.PI_SCIENCE_MCP_EXECUTABLE_PATH ?? process.env.PATH ?? "") {
  if (!isAbsolute(command) && /[\\/]/.test(command)) throw new Error("MCP commands require an absolute path or a bare executable name");
  const candidates = isAbsolute(command) ? [command] : command === "node" ? [process.execPath]
    : operatorPath.split(delimiter).filter(isAbsolute).map((directory) => join(directory, command));
  let executable: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const canonical = await realpath(candidate);
      if (isWithin(workspace, canonical) || !(await stat(canonical)).isFile()) continue;
      executable = canonical; break;
    } catch { /* Continue through trusted PATH entries. */ }
  }
  if (!executable) throw new Error(`MCP executable '${command}' is unavailable outside the writable workspace; install it or configure an absolute executable path`);
  const dependencies = [executable];
  let prefix: string[] = [];
  const handle = await open(executable, "r");
  let header: string;
  try { const buffer = Buffer.alloc(256); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); header = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]!; }
  finally { await handle.close(); }
  if (/^#!\s*(?:\/usr\/bin\/env\s+node|\S*\/node)\s*$/.test(header)) {
    // npm/npx are Node entrypoints; invoke the trusted Node directly rather
    // than relying on /usr/bin/env inside the sandbox's minimal PATH.
    prefix = [executable];
    for (let directory = dirname(executable); dirname(directory) !== directory; directory = dirname(directory)) {
      try { await access(join(directory, "package.json")); dependencies.push(directory); break; } catch { /* Find its narrow package root. */ }
    }
    executable = await realpath(process.execPath); dependencies.push(executable);
  } else if (basename(command) === "uvx" && basename(executable) === "uv") {
    // uv dispatches the uvx symlink via argv[0], which canonicalization loses.
    prefix = ["tool", "run"];
  }
  return { executable, prefix, dependencies };
}
