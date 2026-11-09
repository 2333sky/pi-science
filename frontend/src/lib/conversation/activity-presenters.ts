import { activityCategory, activityFileLabel, activityProgramName, activityReadTarget, type ActivityCategory } from "@pi-science/contracts";
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
  if (READ_TOOLS.has(tool)) return translate("conversation.activity.read", { target: activityReadTarget(input) });
  if (SEARCH_TOOLS.has(tool)) return translate("conversation.activity.search", { target: trim(text(input.pattern) || text(input.query) || "matching code") });
  if (LIST_TOOLS.has(tool)) return translate("conversation.activity.list", { target: activityFileLabel(text(input.path) || text(input.directory) || "workspace files") });
  if (WRITE_TOOLS.has(tool)) return translate("conversation.activity.write", { target: activityFileLabel(text(input.path) || text(input.file_path) || "file") });
  if (WEB_SEARCH_TOOLS.has(tool)) return translate("conversation.activity.webSearch", { target: trim(text(input.query) || "sources") });
  if (RUN_TOOLS.has(tool)) return description || translate("conversation.activity.run", { target: activityProgramName(input) ?? tool });
  return description || translate("conversation.activity.tool", { tool: block.tool.replace(/[_-]+/g, " ").trim() || "tool" });
}

export function toolActivityCategory(block: ToolCallBlock): ActivityCategory {
  return activityCategory({ tool: block.tool, presentationKind: block.presentation?.kind, childSessionId: block.childSessionId });
}

function defaultTranslate(key: string, values: Record<string, unknown> = {}): string { return (DEFAULT_LABELS[key] ?? key).replace(/{{(\w+)}}/g, (_match, name: string) => String(values[name] ?? "")); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function trim(value: string, max = 80): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }
