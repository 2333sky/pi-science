import { readJsonLines, withFileWriteLock, workspaceFile } from "../../storage/persistence.js";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const TITLE_RENAME_RETRIES = 5;
const TITLE_RENAME_RETRY_MS = 20;

/** Persisted session display titles. Kept in the workspace's private state
 *  root so the conversation list
 *  survives browser changes and cache clears (localStorage is only a
 *  transient fallback). A session id maps to at most one title (upsert). */

export interface SessionTitleRecord {
  session_id: string;
  title: string;
  updated_at: string;
  revision: number;
}

/** Records written before revisions existed count as 0 so an upgrade keeps
 *  compare-and-set working against titles the user already had. */
function revisionOf(record: SessionTitleRecord | undefined): number {
  return record && typeof record.revision === "number" && Number.isFinite(record.revision) ? record.revision : 0;
}

function latestRecord(records: SessionTitleRecord[], sessionId: string): SessionTitleRecord | undefined {
  let latest: SessionTitleRecord | undefined;
  for (const record of records) if (record && record.session_id === sessionId) latest = record;
  return latest;
}

export class SessionTitleRepository {
  private file(cwd: string): string {
    return workspaceFile(cwd, "session-titles.jsonl");
  }

  async getTitles(cwd: string): Promise<Map<string, string>> {
    const records = await readJsonLines<SessionTitleRecord>(this.file(cwd));
    const titles = new Map<string, string>();
    for (const record of records) {
      if (record && typeof record.session_id === "string" && typeof record.title === "string" && record.title) {
        // Last write wins (records are appended in write order).
        titles.set(record.session_id, record.title);
      }
    }
    return titles;
  }

  /** Current title and revision, or null when the session has no record.
   *  A record whose title is unusable still reports its revision: a caller that
   *  read 0 there could never win the compare-and-set and the session's title
   *  would stop being regenerable. */
  async getTitleEntry(cwd: string, sessionId: string): Promise<{ title: string; revision: number } | null> {
    const record = latestRecord(await readJsonLines<SessionTitleRecord>(this.file(cwd)), sessionId);
    if (!record) return null;
    return { title: typeof record.title === "string" ? record.title : "", revision: revisionOf(record) };
  }

  /** Upsert a title for a session. Rewrites the file under a lock so a
   *  concurrent rename cannot be lost to an interleaved append. */
  async setTitle(cwd: string, sessionId: string, title: string): Promise<void> {
    const file = this.file(cwd);
    await withFileWriteLock(file, async () => {
      const records = await readJsonLines<SessionTitleRecord>(file);
      const next = records.filter((record) => record?.session_id !== sessionId);
      next.push({ session_id: sessionId, title, updated_at: new Date().toISOString(), revision: revisionOf(latestRecord(records, sessionId)) + 1 });
      await rewriteTitles(file, next);
    });
  }

  /** Write only when the stored revision still equals expected; bumps it on
   *  success. `guard` runs under the same lock, so a caller can require state
   *  that `deleteTitle` also rewrites (a live session) without racing it: a
   *  delete that lands while the title was generating wins either way, and the
   *  record can never outlive its session. */
  async setTitleIfRevision(
    cwd: string,
    sessionId: string,
    title: string,
    expected: number,
    guard?: () => Promise<boolean>,
  ): Promise<{ applied: boolean; revision: number; reason?: "stale" | "gone" }> {
    const file = this.file(cwd);
    return withFileWriteLock(file, async () => {
      const records = await readJsonLines<SessionTitleRecord>(file);
      const current = revisionOf(latestRecord(records, sessionId));
      // A stale generation must not touch the file at all: the winner's title
      // is already the user-visible one and any rewrite here could reorder it.
      if (current !== expected) return { applied: false, revision: current, reason: "stale" as const };
      if (guard && !(await guard())) return { applied: false, revision: current, reason: "gone" as const };
      const revision = current + 1;
      const next = records.filter((record) => record?.session_id !== sessionId);
      next.push({ session_id: sessionId, title, updated_at: new Date().toISOString(), revision });
      await rewriteTitles(file, next);
      return { applied: true, revision };
    });
  }

  async deleteTitle(cwd: string, sessionId: string): Promise<void> {
    const file = this.file(cwd);
    await withFileWriteLock(file, async () => {
      const records = await readJsonLines<SessionTitleRecord>(file);
      const next = records.filter((record) => record?.session_id !== sessionId);
      if (next.length !== records.length) await rewriteTitles(file, next);
    });
  }
}

async function rewriteTitles(file: string, records: SessionTitleRecord[]): Promise<void> {
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  const content = lines ? `${lines}\n` : "";
  // Atomic replace: write a same-directory temp file, then rename over the
  // target so a crash mid-write cannot truncate the whole title store.
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(temporary, content, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporary, file); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EEXIST") throw error;
        if (attempt >= TITLE_RENAME_RETRIES - 1) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, TITLE_RENAME_RETRY_MS * (attempt + 1)));
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export const sessionTitleRepository = new SessionTitleRepository();
