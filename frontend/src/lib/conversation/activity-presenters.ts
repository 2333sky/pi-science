import type { ToolCallBlock } from "../../types/thread";

export type ActivityTranslator = (key: string, values?: Record<string, unknown>) => string;

const DEFAULT_LABELS: Record<string, string> = {
  "conversation.activity.read": "Reading {{target}}", "conversation.activity.search": "Searching for {{target}}", "conversation.activity.list": "Listing {{target}}", "conversation.activity.write": "Updating {{target}}", "conversation.activity.run": "Running {{target}}", "conversation.activity.webSearch": "Searching the web for {{target}}", "conversation.activity.tool": "Running {{tool}}",
};

const READ_TOOLS = new Set(["read", "read_file"]);
const SEARCH_TOOLS = new Set(["grep", "search", "search_files", "rg"]);
const LIST_TOOLS = new Set(["find", "ls", "list_files"]);
const WRITE_TOOLS = new Set(["edit", "write", "write_file", "apply_patch"]);
const WEB_SEARCH_TOOLS = new Set(["web_search", "tavily_search", "search_web"]);
const RUN_TOOLS = new Set(["bash", "python", "run_code", "execute"]);

export function presentToolActivity(block: ToolCallBlock, translate: ActivityTranslator = defaultTranslate): string {
  if (block.presentation?.title?.trim()) return block.presentation.title.trim();
  if (block.title?.trim()) return block.title.trim();
  const input = block.input ?? {};
  const tool = block.tool.trim().toLowerCase();
  const description = text(input.description);
  if (READ_TOOLS.has(tool)) return translate("conversation.activity.read", { target: readTarget(input) });
  if (SEARCH_TOOLS.has(tool)) return translate("conversation.activity.search", { target: trim(text(input.pattern) || text(input.query) || "matching code") });
  if (LIST_TOOLS.has(tool)) return translate("conversation.activity.list", { target: shortPath(text(input.path) || text(input.directory) || "workspace files") });
  if (WRITE_TOOLS.has(tool)) return translate("conversation.activity.write", { target: shortPath(text(input.path) || text(input.file_path) || "file") });
  if (WEB_SEARCH_TOOLS.has(tool)) return translate("conversation.activity.webSearch", { target: trim(text(input.query) || "sources") });
  if (RUN_TOOLS.has(tool)) return description || translate("conversation.activity.run", { target: programName(input) || tool });
  return description || translate("conversation.activity.tool", { tool: block.tool.replace(/[_-]+/g, " ").trim() || "tool" });
}

/** The row names the program being run, never the full command line: the
 *  arguments are where tokens, absolute paths and one-shot destructive intent
 *  live, and the step record is not the place to repeat them. `version` is the
 *  label the row adds next to a running dot and a live tail, so a bare `bash`
 *  ("Running bash") told the reader nothing about what was actually started. */
function programName(input: Record<string, unknown>): string {
  const source = commandText(input.command) || text(input.code) || text(input.script);
  const firstLine = source.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const program = firstLine.split(/\s+/)[0] ?? "";
  return trim(program.replace(/^.*[\\/]/, ""), 40);
}

function commandText(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0].trim() : "";
  return text(value);
}

/** `read` reports where in the file the step looked, because the basename
 *  alone leaves a long file's slice indistinguishable from a whole-file read. */
function readTarget(input: Record<string, unknown>): string {
  const path = shortPath(text(input.path) || text(input.file_path) || "file");
  const start = lineNumber(input.offset ?? input.start_line);
  if (start === undefined) return path;
  const limit = lineNumber(input.limit);
  const end = limit === undefined ? undefined : start + limit - 1;
  return trim(end === undefined ? `${path}:${start}` : `${path}:${start}-${end}`);
}

function lineNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 1_000_000 ? parsed : undefined;
}

function defaultTranslate(key: string, values: Record<string, unknown> = {}): string { return (DEFAULT_LABELS[key] ?? key).replace(/{{(\w+)}}/g, (_match, name: string) => String(values[name] ?? "")); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function shortPath(path: string): string { const parts = path.replace(/\\/g, "/").replace(/\/$/, "").split("/").filter(Boolean); return trim(parts.at(-1) || path || "file"); }
function trim(value: string, max = 80): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }
