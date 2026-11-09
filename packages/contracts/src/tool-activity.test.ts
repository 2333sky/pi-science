import { describe, expect, it } from "vitest";
import {
  activityCategory,
  activityFileLabel,
  activityProgramName,
  activityReadTarget,
} from "./tool-activity.js";

describe("activity classification", () => {
  it.each([
    ["READ", "read"],
    ["rg", "search"],
    ["glob", "browse"],
    ["patch", "edit"],
    ["bash", "execute"],
    ["python", "compute"],
    ["fetch", "web"],
    ["pubmed", "literature"],
    ["image_gen", "generate"],
    ["task", "delegate"],
    ["unknown", "other"],
  ])("classifies %s", (tool, expected) => {
    expect(activityCategory({ tool })).toBe(expected);
  });
  it("prioritizes child, exact tool, kind, then other", () => {
    expect(
      activityCategory({ tool: "read", presentationKind: "edit", childSessionId: "child" }),
    ).toBe("delegate");
    expect(activityCategory({ tool: "read", presentationKind: "edit" })).toBe("read");
    expect(activityCategory({ tool: "unknown", presentationKind: "FETCH" })).toBe("web");
    expect(activityCategory({ tool: "unknown", presentationKind: "unknown" })).toBe("other");
  });
  it.each([
    ["read", "read"],
    ["search", "search"],
    ["fetch", "web"],
    ["edit", "edit"],
    ["execute", "execute"],
    ["compute", "compute"],
    ["verify", "execute"],
    ["artifact", "generate"],
    ["interaction", "other"],
    ["system", "other"],
    ["other", "other"],
  ])("maps fallback %s", (presentationKind, expected) => {
    expect(activityCategory({ tool: "extension", presentationKind })).toBe(expected);
  });
});
describe("safe program name", () => {
  it("accepts plain commands only and caps names", () => {
    expect(activityProgramName({ command: "/usr/bin/pnpm test" })).toBe("pnpm");
    expect(activityProgramName({ command: "x".repeat(50) })).toBe(`${"x".repeat(39)}…`);
  });
  it.each([
    "`",
    "$",
    "|",
    "&",
    ";",
    "<",
    ">",
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    '"',
    "'",
    "\\",
    "=",
    "!",
    "*",
    "?",
    "~",
    "#",
    "^",
  ])("rejects shell character %s", (char) => {
    expect(activityProgramName({ command: `cmd ${char}secret` })).toBeUndefined();
  });
  it.each(
    "env export set unset exec command builtin source eval alias sudo doas nohup xargs cd if then else elif fi for while until do done case esac function declare local typeset let shift trap time nice ionice stdbuf".split(
      " ",
    ),
  )("rejects %s", (command) => {
    expect(activityProgramName({ command })).toBeUndefined();
  });
  it.each([
    { command: "a\nb" },
    { command: ["cmd"] },
    { code: "cmd" },
    { script: "cmd" },
    { command: "/" },
    { command: ".bad" },
    { command: "" },
  ])("rejects unverified input", (input) => {
    expect(activityProgramName(input)).toBeUndefined();
  });
});
describe("read target", () => {
  it.each([
    [{ path: "src/a.ts", offset: 120, limit: 40 }, "a.ts:120-159"],
    [{ file_path: "a.ts", start_line: "120" }, "a.ts:120"],
    [{ path: "a.ts", limit: 40 }, "a.ts"],
    [{ path: "a.ts", offset: 0 }, "a.ts"],
    [{ path: "a.ts", offset: 2, limit: -1 }, "a.ts"],
    [{ path: "a.ts", offset: 1_000_000 }, "a.ts"],
  ])("formats target", (input, expected) => {
    expect(activityReadTarget(input)).toBe(expected);
  });
  it("caps file labels", () => {
    expect(activityFileLabel("a".repeat(90))).toBe(`${"a".repeat(79)}…`);
  });
});
