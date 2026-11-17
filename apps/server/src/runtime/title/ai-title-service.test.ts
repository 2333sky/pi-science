import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiTitleService,
  aiTitlesEnabled,
  cleanTitle,
  type TitleGenerator,
} from "./ai-title-service.js";

async function makeSession(
  cwd: string,
  sessionId: string,
  rows: Array<{ role: string; text: string }>,
) {
  const root = join(cwd, ".pi-science", "sessions");
  await mkdir(root, { recursive: true });
  const header = JSON.stringify({
    id: sessionId,
    type: "session",
    cwd,
    timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  });
  const lines = rows.map((row, index) =>
    JSON.stringify({
      id: `${sessionId}-${index}`,
      type: "message",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      message: { role: row.role, content: [{ type: "text", text: row.text }] },
    }),
  );
  await writeFile(join(root, `${sessionId}.jsonl`), [header, ...lines].join("\n"));
}

describe("cleanTitle", () => {
  it("normalizes a short title and rejects empty or over-long output", () => {
    expect(cleanTitle('  "单细胞数据 QC 分析"  ')).toBe("单细胞数据 QC 分析");
    expect(cleanTitle("Title: RNA-seq 差异表达\n分析")).toBe("RNA-seq 差异表达 分析");
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle("x".repeat(51))).toBeNull();
  });
});

describe("AiTitleService", () => {
  let cwd: string;
  let sessionId: string;

  beforeEach(async () => {
    cwd = join(tmpdir(), `pi-science-title-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(cwd, { recursive: true });
    sessionId = `sess-${Math.random().toString(16).slice(2)}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });

  it("reads recent conversation text and makes one direct generation request", async () => {
    await makeSession(cwd, sessionId, [
      { role: "user", text: "帮我分析这个单细胞数据" },
      { role: "assistant", text: "我先看一下数据。" },
      { role: "user", text: "做下质控" },
    ]);
    const prompts: string[] = [];
    const generator: TitleGenerator = {
      async generate(prompt, signal) {
        expect(signal.aborted).toBe(false);
        prompts.push(prompt);
        return '"单细胞数据 QC 分析"';
      },
    };
    await expect(new AiTitleService(generator).generateTitle(cwd, sessionId)).resolves.toBe(
      "单细胞数据 QC 分析",
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("user: 做下质控");
  });

  it("deduplicates concurrent requests for the same session", async () => {
    await makeSession(cwd, sessionId, [{ role: "user", text: "hi" }]);
    let calls = 0;
    const generator: TitleGenerator = {
      async generate() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "Same title";
      },
    };
    const service = new AiTitleService(generator);
    await expect(
      Promise.all([service.generateTitle(cwd, sessionId), service.generateTitle(cwd, sessionId)]),
    ).resolves.toEqual(["Same title", "Same title"]);
    expect(calls).toBe(1);
  });

  it("returns null for disabled, empty-history, failed, and timed-out generation", async () => {
    expect(aiTitlesEnabled()).toBe(true);
    vi.stubEnv("PI_SCIENCE_AI_TITLES", "0");
    const disabled = vi.fn<TitleGenerator["generate"]>();
    expect(aiTitlesEnabled()).toBe(false);
    await expect(
      new AiTitleService({ generate: disabled }).generateTitle(cwd, sessionId),
    ).resolves.toBeNull();
    expect(disabled).not.toHaveBeenCalled();

    vi.stubEnv("PI_SCIENCE_AI_TITLES", "1");
    await makeSession(cwd, sessionId, [{ role: "system", text: "ignored" }]);
    const unused = vi.fn<TitleGenerator["generate"]>();
    await expect(
      new AiTitleService({ generate: unused }).generateTitle(cwd, sessionId),
    ).resolves.toBeNull();
    expect(unused).not.toHaveBeenCalled();

    await makeSession(cwd, sessionId, [{ role: "user", text: "hello" }]);
    await expect(
      new AiTitleService({
        generate: async () => Promise.reject(new Error("provider failed")),
      }).generateTitle(cwd, sessionId),
    ).resolves.toBeNull();
    await expect(
      new AiTitleService(
        {
          generate: (_prompt, signal) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            ),
        },
        true,
        5,
      ).generateTitle(cwd, sessionId),
    ).resolves.toBeNull();
  });
});
