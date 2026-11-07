import type { ToolCallBlock } from "../../types/thread";

export type ActivityTranslator = (key: string, values?: Record<string, unknown>) => string;

const DEFAULT_LABELS: Record<string, string> = {
  "conversation.activity.terminal": "Terminal", "conversation.activity.fetch": "Fetching {{target}}", "conversation.activity.read": "Reading {{target}}", "conversation.activity.search": "Searching for {{target}}", "conversation.activity.list": "Listing {{target}}", "conversation.activity.write": "Updating {{target}}", "conversation.activity.run": "Running {{target}}", "conversation.activity.webSearch": "Searching the web for {{target}}", "conversation.activity.tool": "Running {{tool}}",
  "conversation.activity.memory.search": "Search memory",
  "conversation.activity.memory.read": "Read memory",
  "conversation.activity.memory.write": "Update memory",
  "conversation.activity.citation.verify": "Verify citations",
  "conversation.activity.citation.read": "Read source evidence",
  "conversation.activity.citation.record": "Record evidence citations",
  "conversation.activity.delegate": "Delegate task",
  "conversation.activity.delegate.list": "List subagents",
  "conversation.activity.delegate.status": "Check subagent status",
  "conversation.activity.delegate.collect": "Collect subagent results",
  "conversation.activity.delegate.stop": "Stop subagent",
  "conversation.activity.delegate.manage": "Manage subagents",
  "conversation.activity.reasoning": "Thinking",
};

/** Tool names are matched exactly; MCP names never enter built-in inference. */
export function activityToolName(tool: string): string {
  return tool.trim().toLowerCase();
}

export function isMcpTool(tool: string): boolean {
  return activityToolName(tool).startsWith("mcp__");
}

function mcpActivityLabel(tool: string): string {
  const [server, ...name] = tool.trim().slice(5).split("__");
  return server && name.length ? `${server} · ${name.join("__")}` : tool.trim();
}

export function activityTaskTitle(block: ToolCallBlock): string | undefined {
  const description = text(block.presentation?.description) || text(block.input?.description);
  return description ? trim(description.replace(/\s+/g, " "), 160)
    : meaningfulActivityTitle(block.presentation?.title, block.tool) ?? meaningfulActivityTitle(block.title, block.tool);
}

export function activityTarget(block: ToolCallBlock): string {
  const input = block.input ?? {};
  for (const key of ["query", "q", "pattern", "search_query", "path", "file_path", "directory", "url", "doi", "pmcid", "accession", "identifier", "gene", "name"]) {
    const value = text(input[key]);
    if (value) return trim(shellCommandPreview(value));
  }
  return "";
}

export function presentToolActivity(block: ToolCallBlock, translate: ActivityTranslator = defaultTranslate): string {
  if (isMcpTool(block.tool)) return mcpActivityLabel(block.tool);
  const title = activityTaskTitle(block);
  if (title) return title;
  const input = block.input ?? {};
  const tool = activityToolName(block.tool);
  const path = text(input.path) || text(input.file_path) || text(input.directory);
  const target = activityTarget(block);
  const append = (label: string, value: string = target) => value ? `${label} · ${value}` : label;
  if (tool === "search_memory") return append(translate("conversation.activity.memory.search"));
  if (tool === "read_memory") return append(translate("conversation.activity.memory.read"), trim(text(input.id), 8));
  if (tool === "write_memory") {
    const content = input.content && typeof input.content === "object" ? input.content as Record<string, unknown> : {};
    return append(translate("conversation.activity.memory.write"), trim(text(content.title) || text(input.reason)));
  }
  if (tool === "verify_citations") return translate("conversation.activity.citation.verify");
  if (tool === "read_source_evidence") return append(translate("conversation.activity.citation.read"), trim(shellCommandPreview(text(input.source))));
  if (tool === "cite_evidence") {
    const selections = Array.isArray(input.selections) ? input.selections : [];
    const sources = [...new Set(selections.flatMap((selection: unknown) => {
      const source = selection && typeof selection === "object" ? text((selection as Record<string, unknown>).source) : "";
      return source ? [source] : [];
    }))];
    return append(translate("conversation.activity.citation.record"), trim(shellCommandPreview(sources.join(", "))));
  }
  if (tool === "subagent") return append(translate("conversation.activity.delegate"), trim(text(input.agent)));
  if (tool === "subagent_control") {
    const action = text(input.action);
    return ["list", "status", "collect", "stop"].includes(action)
      ? translate(`conversation.activity.delegate.${action}`)
      : translate("conversation.activity.delegate.manage");
  }
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
