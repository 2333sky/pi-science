import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve } from "node:path";

/** Linux descriptor walk pins every directory and refuses symlinks in all components.
 * Never open a FIFO/device while establishing the regular-file boundary. */
async function withRegularFile<T>(path: string, maximum: number, consume: (handle: FileHandle, size: number) => Promise<T>): Promise<T> {
  if (process.platform !== "linux" || !isAbsolute(path) || resolve(path) !== path) throw new Error("File reads require canonical Linux paths");
  const parts = relative(parse(path).root, path).split("/");
  const handles: FileHandle[] = [];
  try {
    let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY); handles.push(parent);
    for (const part of parts.slice(0, -1)) { parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(parent); }
    const handle = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); handles.push(handle);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) throw new Error("Read requires a bounded single-link regular file");
    const result = await consume(handle, Number(before.size));
    const after = await handle.stat({ bigint: true });
    if (after.nlink !== 1n || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("File changed during capture");
    return result;
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

export async function readRegularFile(path: string, maximum: number): Promise<Buffer> {
  return withRegularFile(path, maximum, async (handle, size) => {
    const buffer = Buffer.alloc(size + 1); let length = 0;
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length !== size) throw new Error("File changed during capture");
    return buffer.subarray(0, length);
  });
}
