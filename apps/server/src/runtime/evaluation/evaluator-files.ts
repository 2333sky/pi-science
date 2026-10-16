import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { canonicalDirectory } from "../sandbox/policy.js";

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

export const EVALUATOR_CHUNK_BYTES = 64 * 1024;
/** One budget per registry operation, shared by evaluator/data/environment. */
export class EvaluatorReadBudget {
  readonly buffer = Buffer.alloc(EVALUATOR_CHUNK_BYTES);
  private used = 0;
  private entries = 0;
  constructor(readonly maximum = MAX_BUNDLE_BYTES) {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_BUNDLE_BYTES) throw new Error("Invalid evaluator read budget");
  }
  get remaining() { return this.maximum - this.used; }
  consume(bytes: number) { if (bytes > this.remaining) throw new Error("Evaluator aggregate byte budget exceeded"); this.used += bytes; }
  enter() { if (++this.entries > 10_000) throw new Error("Evaluator aggregate entry budget exceeded"); }
}

/** Linux descriptor walk pins every directory and refuses symlinks in all components.
 * Never open a FIFO/device while establishing the regular-file boundary. */
async function withEvaluatorFile<T>(path: string, maximum: number, consume: (handle: FileHandle, size: number, executable: boolean) => Promise<T>): Promise<T> {
  if (process.platform !== "linux" || !isAbsolute(path) || resolve(path) !== path) throw new Error("Evaluator file reads require canonical Linux paths");
  const parts = relative(parse(path).root, path).split("/");
  const handles: FileHandle[] = [];
  try {
    let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY); handles.push(parent);
    for (const part of parts.slice(0, -1)) { parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(parent); }
    const handle = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); handles.push(handle);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) throw new Error("Invalid evaluator file or aggregate byte budget exceeded");
    const result = await consume(handle, Number(before.size), (before.mode & 0o111n) !== 0n);
    const after = await handle.stat({ bigint: true });
    if (after.nlink !== 1n || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Evaluator file changed during capture");
    return result;
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

export async function readEvaluatorFile(path: string, maximum: number): Promise<Buffer> {
  return withEvaluatorFile(path, maximum, async (handle, size) => {
    const buffer = Buffer.alloc(size + 1); let length = 0;
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length !== size) throw new Error("Evaluator file changed during capture");
    return buffer.subarray(0, length);
  });
}

export interface FrozenFile { path: string; sha256: string; executable: boolean }
/** Stream exact descriptor bytes into a private snapshot when requested. Verification
 * retains only bounded file metadata; digest format is unchanged for existing revisions. */
export async function captureEvaluatorTree(root: string, budget: EvaluatorReadBudget, destination?: string): Promise<{ files: FrozenFile[]; digest: string }> {
  await canonicalDirectory(root);
  const files: FrozenFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    await canonicalDirectory(directory);
    for await (const entry of await opendir(directory)) {
      budget.enter();
      const path = join(directory, entry.name); const info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      else await withEvaluatorFile(path, budget.remaining, async (handle, size, executable) => {
        const name = relative(root, path); const hash = createHash("sha256"); let length = 0;
        let output: FileHandle | undefined;
        try {
          if (destination) { const target = join(destination, name); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); output = await open(target, "wx", executable ? 0o500 : 0o400); }
          while (true) {
            const { bytesRead } = await handle.read(budget.buffer, 0, Math.min(budget.buffer.length, size - length + 1), null);
            if (!bytesRead) break;
            length += bytesRead;
            if (length > size) throw new Error("Evaluator file changed during capture");
            budget.consume(bytesRead);
            const chunk = budget.buffer.subarray(0, bytesRead); hash.update(chunk); await output?.writeFile(chunk);
          }
          if (length !== size) throw new Error("Evaluator file changed during capture");
          files.push({ path: name, sha256: hash.digest("hex"), executable });
        } finally { await output?.close(); }
      });
    }
  };
  await visit(root);
  if (!files.length) throw new Error("Evaluator bundle must contain files");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, digest: sha256(JSON.stringify(files.map((file) => [file.path, file.executable, file.sha256]))) };
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
