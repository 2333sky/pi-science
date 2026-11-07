import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../types/thread";
import { presentToolActivity } from "./activity-presenters";
const block = (tool: string, input?: Record<string, unknown>, title?: string): ToolCallBlock => ({ kind: "tool", id: tool, callId: tool, tool, status: "running", input, title });
describe("presentToolActivity", () => {
  it("prefers the server title", () => { expect(presentToolActivity(block("bash", {}, "Running tests"))).toBe("Running tests"); });
  it("presents file and search actions", () => { expect(presentToolActivity(block("read", { path: "src/file.ts" }))).toBe("Reading file.ts"); expect(presentToolActivity(block("grep", { pattern: "tool.updated" }))).toBe("Searching for tool.updated"); });
  it("prefers command descriptions and otherwise shows the command", () => {
    expect(presentToolActivity(block("bash", { command: "pnpm test", description: "Running tests" }))).toBe("Running tests");
    expect(presentToolActivity(block("bash", { command: "pnpm test" }, "Running bash"))).toBe("Running pnpm test");
    expect(presentToolActivity(block("bash", { command: "rm -rf x" }))).toBe("Running rm -rf x");
  });

  it("redacts credential flags, environment assignments and URL credentials", () => {
    expect(presentToolActivity(block("bash", { command: 'curl --token="private value" -H "Authorization: Bearer abc123" https://user:password@example.com/api?key=hidden' }))).toBe('Running curl --token=[redacted] -H "Authorization: [redacted]" https://example.com/api');
    expect(presentToolActivity(block("bash", { command: "TOKEN=secret pnpm test" }))).toBe("Running TOKEN=[redacted] pnpm test");
  });

  it("shows echo-prefixed compound commands and bounds multiline previews", () => {
    expect(presentToolActivity(block("bash", { command: 'echo "第 1 次调用"; date; hostname' }))).toBe('Running echo "第 1 次调用"; date; hostname');
    const command = "python3 -c \"\n" + "print(1)\n".repeat(100) + "\"";
    const title = presentToolActivity(block("bash", { command }));
    expect(title).toContain("python3 -c");
    expect(title).not.toContain("\n");
    expect(title).toHaveLength(168);
    expect(title.endsWith("…")).toBe(true);
  });

  it("uses a generic tool's display description when its title is a placeholder", () => {
    const tool = block("mcp_lookup", { token: "secret" }, "Running mcp lookup");
    tool.presentation = { version: 1, kind: "search", title: "mcp_lookup", description: "Look up study metadata", importance: "micro", domain: "research" };
    expect(presentToolActivity(tool)).toBe("Look up study metadata");
  });
});
