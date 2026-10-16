import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { canonicalDirectory } from "../sandbox/policy.js";

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

/** Linux descriptor walk pins every directory and refuses symlinks in all components.
 * Never open a FIFO/device while establishing the regular-file boundary. */
export async function readEvaluatorFile(path: string, maximum: number): Promise<Buffer> {
  if (process.platform !== "linux" || !isAbsolute(path) || resolve(path) !== path) throw new Error("Evaluator file reads require canonical Linux paths");
  const parts = relative(parse(path).root, path).split("/");
  const handles: FileHandle[] = [];
  try {
    let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY); handles.push(parent);
    for (const part of parts.slice(0, -1)) { parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(parent); }
    const handle = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); handles.push(handle);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) throw new Error("Invalid evaluator file");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat({ bigint: true });
    if (length !== Number(before.size) || after.nlink !== 1n || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Evaluator file changed during capture");
    return buffer.subarray(0, length);
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

export interface FrozenFile { path: string; bytes: Buffer; executable: boolean }
/** Bounded deterministic tree capture. Exact returned bytes, not a later path read, are frozen. */
export async function captureEvaluatorTree(root: string): Promise<{ files: FrozenFile[]; digest: string }> {
  await canonicalDirectory(root);
  const files: FrozenFile[] = []; let total = 0; let entries = 0;
  const visit = async (directory: string): Promise<void> => {
    await canonicalDirectory(directory);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (++entries > 10_000) throw new Error("Evaluator bundle has too many entries");
      const path = join(directory, entry.name); const info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      else {
        const bytes = await readEvaluatorFile(path, MAX_BUNDLE_BYTES - total); total += bytes.length;
        files.push({ path: relative(root, path), bytes, executable: (info.mode & 0o111) !== 0 });
      }
    }
  };
  await visit(root);
  if (!files.length) throw new Error("Evaluator bundle must contain files");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = sha256(JSON.stringify(files.map((file) => [file.path, file.executable, sha256(file.bytes)])));
  return { files, digest };
}

export async function requirePrivateDirectory(path: string): Promise<void> {
  await canonicalDirectory(path);
  for (let current = path; dirname(current) !== current; current = dirname(current)) {
    const info = await lstat(current);
    // Sticky shared ancestors (e.g. /tmp) prevent other users from replacing our owned root.
    if ((info.mode & 0o022) && !(info.mode & 0o1000)) throw new Error("Evaluator state has a writable ancestor");
  }
  const info = await lstat(path);
  if ((info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error("Evaluator state must be operator-owned and private");
}
