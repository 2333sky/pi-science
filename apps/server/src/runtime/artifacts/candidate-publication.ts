import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { withFileWriteLock, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";

const schema = z.object({ artifact_id: z.string(), version: z.number().int().positive(), path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(), executionId: z.string(), sessionId: z.string() }).strict();
export type CandidatePublication = z.infer<typeof schema>;
const file = (cwd: string, id: string, version: number) => workspaceFile(cwd, `candidate-publications/${createHash("sha256").update(JSON.stringify([id, version])).digest("hex")}.json`);
/** Only trusted execution publication adapters call this. Public artifact/provenance routes do not. */
export async function recordCandidatePublication(cwd: string, value: CandidatePublication): Promise<void> {
  schema.parse(value);
  const path = file(cwd, value.artifact_id, value.version);
  await withFileWriteLock(path, async () => {
    const records = await candidatePublications(cwd, value.artifact_id, value.version);
    if (!records.some((record) => record.executionId === value.executionId)) await writeJsonAtomic(path, [...records, value], { mode: 0o600 });
  });
}
export async function candidatePublications(cwd: string, id: string, version: number): Promise<CandidatePublication[]> {
  try { return z.array(schema).max(1000).parse(JSON.parse(await readFile(file(cwd, id, version), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
