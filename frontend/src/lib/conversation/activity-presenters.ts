import type { ToolCallBlock } from "../../types/thread";

export type ActivityTranslator = (key: string, values?: Record<string, unknown>) => string;

const DEFAULT_LABELS: Record<string, string> = {
  "conversation.activity.terminal": "Terminal", "conversation.activity.fetch": "Fetching {{target}}", "conversation.activity.read": "Reading {{target}}", "conversation.activity.search": "Searching for {{target}}", "conversation.activity.list": "Listing {{target}}", "conversation.activity.write": "Updating {{target}}", "conversation.activity.run": "Running {{target}}", "conversation.activity.webSearch": "Searching the web for {{target}}", "conversation.activity.tool": "Running {{tool}}",
};

/** MCP names retain their connector identity in details, but share the same UI rules. */
export function activityToolName(tool: string): string {
  const name = tool.trim().toLowerCase();
  return name.startsWith("mcp__") ? name.split("__").at(-1) || name : name;
}

export function activityTaskTitle(block: ToolCallBlock): string | undefined {
  const description = text(block.presentation?.description) || text(block.input?.description);
  return description ? trim(description.replace(/\s+/g, " "), 160)
    : meaningfulActivityTitle(block.presentation?.title, block.tool) ?? meaningfulActivityTitle(block.title, block.tool);
}

export function activityTarget(block: ToolCallBlock): string {
  const input = block.input ?? {};
  for (const key of ["query", "pattern", "search_query", "path", "file_path", "directory", "url", "doi", "pmcid", "accession", "identifier", "gene", "name"]) {
    const value = text(input[key]);
    if (value) return trim(shellCommandPreview(value));
  }
  return "";
}

export function presentToolActivity(block: ToolCallBlock, translate: ActivityTranslator = defaultTranslate): string {
  const title = activityTaskTitle(block);
  if (title) return title;
  const input = block.input ?? {};
  const tool = activityToolName(block.tool);
  const path = text(input.path) || text(input.file_path) || text(input.directory);
  const target = activityTarget(block);
  if (["read", "read_file", "notebook_read", "view_image"].includes(tool)) return translate("conversation.activity.read", { target: shortPath(path || "file") });
  if (["grep", "glob", "search", "search_files", "rg", "find"].includes(tool)) return translate("conversation.activity.search", { target: target || "matching files" });
  if (["ls", "list", "list_files"].includes(tool)) return translate("conversation.activity.list", { target: shortPath(path || "workspace files") });
  if (["edit", "write", "write_file", "apply_patch", "notebook_edit"].includes(tool)) return translate("conversation.activity.write", { target: shortPath(path || "file") });
  if (["web_search", "tavily_search", "search_web"].includes(tool)) return translate("conversation.activity.webSearch", { target: target || "sources" });
  if (["web_fetch", "fetch_url", "fetch", "read_url"].includes(tool)) return translate("conversation.activity.fetch", { target: target || "web page" });
  if (tool === "notebook_run") return translate("conversation.activity.run", { target: shortPath(path || "notebook") });
  if (tool === "bash") return shellCommandPreview(text(input.command)) || translate("conversation.activity.terminal");
  if (/^(search|find)_/.test(tool) && target) return translate("conversation.activity.search", { target });
  if (/^(get|fetch|read)_/.test(tool) && target) return translate("conversation.activity.read", { target });
  if (/^list_/.test(tool) && target) return translate("conversation.activity.list", { target });
  const label = tool.replace(/[_-]+/g, " ").trim() || "tool";
  return target ? `${label} · ${target}` : label;
}

export function shellCommandPreview(command: string): string {
  // Redact before shortening so a clipped credential cannot become a preview.
  const redacted = command
    .replace(/(\b[\w-]*(?:api[_-]?key|token|secret|password|credential|authorization|cookie)[\w-]*\s*(?:[:=]\s*|\s+))(?:(?:Bearer|Basic)\s+)?("(?:\\.|[^"])*(?:"|$)|'(?:[^'])*(?:'|$)|[^\s;|&"']+)/gi, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]")
    .replace(/\b([A-Z][A-Z0-9_]*=)("(?:\\.|[^"])*(?:"|$)|'(?:[^'])*(?:'|$)|[^\s;|&]+)/g, "$1[redacted]")
    .replace(/https?:\/\/[^\s"'\x60)]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch { return "[redacted-url]"; }
    });
  return trim(redacted.replace(/\s+/g, " ").trim(), 160);
}

export function meaningfulActivityTitle(title: string | undefined, tool: string): string | undefined {
  const value = text(title);
  if (!value) return undefined;
  const normalize = (name: string) => name.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const normalizedTitle = normalize(value);
  const names = [normalize(tool), normalize(activityToolName(tool))];
  if (names.some((name) => [name, `running ${name}`, `正在运行 ${name}`, `正在执行 ${name}`].includes(normalizedTitle))) return undefined;
  return value;
}

function defaultTranslate(key: string, values: Record<string, unknown> = {}): string { return (DEFAULT_LABELS[key] ?? key).replace(/{{(\w+)}}/g, (_match, name: string) => String(values[name] ?? "")); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function shortPath(path: string): string { const parts = path.replace(/\\/g, "/").replace(/\/$/, "").split("/").filter(Boolean); return trim(parts.at(-1) || path || "file"); }
function trim(value: string, max = 80): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }
