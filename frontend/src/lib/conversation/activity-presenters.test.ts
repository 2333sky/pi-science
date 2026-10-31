import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../types/thread";
import { presentToolActivity } from "./activity-presenters";
const block = (tool: string, input?: Record<string, unknown>, title?: string): ToolCallBlock => ({ kind: "tool", id: tool, callId: tool, tool, status: "running", input, title });
describe("presentToolActivity", () => {
  it("prefers the server title", () => { expect(presentToolActivity(block("bash", {}, "Running tests"))).toBe("Running tests"); });
  it("presents file and search actions", () => { expect(presentToolActivity(block("read", { path: "src/file.ts" }))).toBe("Reading file.ts"); expect(presentToolActivity(block("grep", { pattern: "tool.updated" }))).toBe("Searching for tool.updated"); });
  it("uses command descriptions without exposing raw commands", () => { expect(presentToolActivity(block("bash", { command: "pnpm test", description: "Running tests" }))).toBe("Running tests"); const destructive = presentToolActivity(block("bash", { command: "rm -rf x" }));
    // The program is named so the row is not just "Running bash"; the
    // arguments stay out of the trace.
    expect(destructive).toBe("Running rm");
    expect(destructive).not.toContain("-rf"); });
  it("names the program that runs and the slice that is read", () => {
    expect(presentToolActivity(block("bash", { command: "/usr/bin/pnpm --filter web test" }))).toBe("Running pnpm");
    expect(presentToolActivity(block("read", { path: "/repo/apps/server/src/a.ts", offset: 120, limit: 40 }))).toBe("Reading a.ts:120-159");
    expect(presentToolActivity(block("read", { path: "/repo/apps/server/src/a.ts" }))).toBe("Reading a.ts");
  });
});
