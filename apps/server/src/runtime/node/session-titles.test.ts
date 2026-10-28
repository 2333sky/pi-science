import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionTitleRepository } from "./session-titles.js";

const cleanup: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pi-science-titles-${Date.now()}-`));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionTitleRepository", () => {
  it("returns an empty map when no titles were stored", async () => {
    const repo = new SessionTitleRepository();
    const titles = await repo.getTitles(await workspace());
    expect(titles.size).toBe(0);
  });

  it("upserts a title (later write wins for the same session)", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setTitle(cwd, "s1", "first");
    await repo.setTitle(cwd, "s1", "second");
    await repo.setTitle(cwd, "s2", "other");
    const titles = await repo.getTitles(cwd);
    expect(titles.get("s1")).toBe("second");
    expect(titles.get("s2")).toBe("other");
    expect(titles.size).toBe(2);
    // The superseded entry is actually removed from the file (not just shadowed).
    const file = join(cwd, ".pi-science", "session-titles.jsonl");
    const raw = await readFile(file, "utf8");
    expect(raw.match(/"first"/)).toBeNull();
    expect(raw.match(/"second"/)).not.toBeNull();
  });

  it("deletes a title for a session and keeps the others", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setTitle(cwd, "s1", "one");
    await repo.setTitle(cwd, "s2", "two");
    await repo.deleteTitle(cwd, "s1");
    const titles = await repo.getTitles(cwd);
    expect(titles.has("s1")).toBe(false);
    expect(titles.get("s2")).toBe("two");
  });

  it("is isolated per workspace", async () => {
    const repo = new SessionTitleRepository();
    const a = await workspace();
    const b = await workspace();
    await repo.setTitle(a, "s1", "in-a");
    expect((await repo.getTitles(b)).size).toBe(0);
    expect((await repo.getTitles(a)).get("s1")).toBe("in-a");
  });

  it("keeps the file as valid JSONL with a trailing newline and leaves no temp files", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setTitle(cwd, "s1", "one");
    await repo.setTitle(cwd, "s2", "two");
    await repo.setTitle(cwd, "s1", "one-updated");
    await repo.deleteTitle(cwd, "s2");
    const file = join(cwd, ".pi-science", "session-titles.jsonl");
    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter(Boolean).map((line) => JSON.parse(line))).toEqual([
      { session_id: "s1", title: "one-updated", updated_at: expect.any(String), revision: 2 },
    ]);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(cwd, ".pi-science"));
    expect(entries).toEqual(expect.not.arrayContaining([expect.stringContaining(".tmp")]));
  });

  it("ignores corrupt records when reading", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(
      join(cwd, ".pi-science", "session-titles.jsonl"),
      '{"session_id":"s1","title":"ok","updated_at":"2026-01-01T00:00:00.000Z"}\nnot-json\n{"session_id":"s2","title":123}\n',
      "utf8",
    );
    const titles = await repo.getTitles(cwd);
    expect(titles.get("s1")).toBe("ok");
    expect(titles.has("s2")).toBe(false);
  });

  it("starts a fresh session at revision 0 and bumps it on every write", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    expect(await repo.getTitleEntry(cwd, "s1")).toBeNull();
    await repo.setTitle(cwd, "s1", "first");
    expect(await repo.getTitleEntry(cwd, "s1")).toEqual({ title: "first", revision: 1 });
    await repo.setTitle(cwd, "s1", "second");
    expect(await repo.getTitleEntry(cwd, "s1")).toEqual({ title: "second", revision: 2 });
  });

  it("reads a record written before revisions existed as 0 and stores 1 on the next write", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(
      join(cwd, ".pi-science", "session-titles.jsonl"),
      '{"session_id":"legacy","title":"Old title","updated_at":"2026-01-01T00:00:00.000Z"}\n',
      "utf8",
    );
    expect(await repo.getTitleEntry(cwd, "legacy")).toEqual({ title: "Old title", revision: 0 });
    expect(await repo.setTitleIfRevision(cwd, "legacy", "New title", 0)).toEqual({ applied: true, revision: 1 });
    expect(await repo.getTitleEntry(cwd, "legacy")).toEqual({ title: "New title", revision: 1 });
    await repo.setTitle(cwd, "legacy", "Forced title");
    expect(await repo.getTitleEntry(cwd, "legacy")).toEqual({ title: "Forced title", revision: 2 });
  });

  it("applies a conditional write on an equal revision", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setTitle(cwd, "s1", "base");
    const entry = await repo.getTitleEntry(cwd, "s1");
    expect(await repo.setTitleIfRevision(cwd, "s1", "generated", entry!.revision)).toEqual({ applied: true, revision: 2 });
    expect(await repo.getTitleEntry(cwd, "s1")).toEqual({ title: "generated", revision: 2 });
  });

  it("refuses a stale conditional write without touching the file or the revision", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setTitle(cwd, "s1", "manual");
    const file = join(cwd, ".pi-science", "session-titles.jsonl");
    const before = await readFile(file, "utf8");
    expect(await repo.setTitleIfRevision(cwd, "s1", "late generated", 0)).toEqual({ applied: false, revision: 1 });
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await repo.getTitleEntry(cwd, "s1")).toEqual({ title: "manual", revision: 1 });
  });

  it("refuses a conditional write for a session that has no record yet from a stale expectation", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    expect(await repo.setTitleIfRevision(cwd, "missing", "generated", 3)).toEqual({ applied: false, revision: 0 });
    await expect(readFile(join(cwd, ".pi-science", "session-titles.jsonl"), "utf8")).rejects.toThrow();
  });
});
