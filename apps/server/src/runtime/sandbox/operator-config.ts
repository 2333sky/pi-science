import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, relative } from "node:path";

/** Service-owned configuration must never come from an agent-writable file. */
export async function readOperatorConfig(file: string, maxBytes = 64 * 1024): Promise<unknown> {
  if (!isAbsolute(file) || resolve(file) !== file) throw new Error("Operator sandbox config requires a canonical absolute path");
  if (relative(dirname(file), await realpath(dirname(file))) !== "") throw new Error("Operator config directory aliases and symlinks are forbidden");
  for (let directory = dirname(file);; directory = dirname(directory)) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Operator config directory aliases and symlinks are forbidden");
    if (process.platform !== "win32" && (info.mode & 0o022) && !(info.mode & 0o1000)) throw new Error(`Operator sandbox config has a writable ancestor: ${directory} (mode ${(info.mode & 0o7777).toString(8)}). Remove group/other write permission from this directory or move PI_SCIENCE_HOME / the operator config to a private directory with trusted ancestors.`);
    if (dirname(directory) === directory) break;
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes) || (process.platform !== "win32" && ((before.mode & 0o077n) || before.uid !== BigInt(process.getuid!())))) throw new Error("Operator sandbox config must be a private single-link regular file");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (length !== Number(before.size) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) throw new Error("Operator sandbox config changed during read");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
  } finally { await handle.close(); }
}
