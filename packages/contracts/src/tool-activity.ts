export const ACTIVITY_CATEGORIES = [
  "read",
  "search",
  "browse",
  "edit",
  "execute",
  "compute",
  "web",
  "literature",
  "generate",
  "delegate",
  "other",
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

const TOOLS: Record<Exclude<ActivityCategory, "other">, string[]> = {
  read: ["read", "read_file", "notebook_read", "view_image"],
  search: ["grep", "rg", "search", "search_files"],
  browse: ["glob", "find", "ls", "list", "list_files"],
  edit: [
    "edit",
    "write",
    "write_file",
    "apply_patch",
    "patch",
    "notebook_edit",
    "delete",
    "delete_file",
    "move",
    "rename",
  ],
  execute: [
    "bash",
    "execute",
    "run_code",
    "pytest",
    "vitest",
    "lint",
    "typecheck",
    "build",
    "compile",
    "check",
    "test",
    "jest",
  ],
  compute: ["python", "notebook", "notebook_run", "run_cell", "execute_code"],
  web: ["web_search", "search_web", "tavily_search", "web_fetch", "fetch"],
  literature: [
    "search_pubmed",
    "search_arxiv",
    "search_crossref",
    "search_biorxiv_preprints",
    "get_europe_pmc_full_text",
    "pubmed",
    "crossref",
    "semantic_scholar",
    "search_semantic_scholar",
    "literature",
  ],
  generate: ["image_gen", "image_generation", "generate_image", "create_image", "render_image"],
  delegate: ["subagent", "delegate", "spawn_agent", "task"],
};
/** The literature tools, exported so a renderer can select on the same names the
 *  glyph table uses instead of keeping a second copy that drifts. */
export const ACTIVITY_LITERATURE_TOOLS: readonly string[] = TOOLS.literature;
const KINDS: Record<string, ActivityCategory> = {
  read: "read",
  search: "search",
  fetch: "web",
  edit: "edit",
  execute: "execute",
  compute: "compute",
  verify: "execute",
  artifact: "generate",
  interaction: "other",
  system: "other",
  other: "other",
};
const TOOL_CATEGORIES = new Map(
  Object.entries(TOOLS).flatMap(([category, names]) =>
    names.map((name) => [name, category as ActivityCategory]),
  ),
);
// A child session is a delegate whatever tool it ran; an exact tool name beats a
// presentation kind, so a precise mapping can refine a coarse server semantic.
export function activityCategory(input: {
  tool: string;
  presentationKind?: string;
  childSessionId?: string;
}): ActivityCategory {
  if (input.childSessionId) return "delegate";
  const exact = TOOL_CATEGORIES.get(input.tool.trim().toLowerCase());
  if (exact) return exact;
  const kind = input.presentationKind?.toLowerCase() ?? "";
  return Object.hasOwn(KINDS, kind) ? KINDS[kind]! : "other";
}
function trim(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
export function activityFileLabel(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/$/, "").split("/").filter(Boolean);
  return trim(parts.at(-1) || path || "file", 80);
}
function lineNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 1_000_000 ? parsed : undefined;
}
export function activityReadTarget(input: Record<string, unknown>): string {
  const file = activityFileLabel(text(input.path) || text(input.file_path) || "file");
  const start = lineNumber(input.offset ?? input.start_line);
  if (start === undefined) return file;
  const limit = lineNumber(input.limit);
  if (input.limit != null && limit === undefined) return file;
  return limit === undefined ? `${file}:${start}` : `${file}:${start}-${start + limit - 1}`;
}
const DENY = new Set(
  "env export set unset exec command builtin source eval alias sudo doas nohup xargs cd if then else elif fi for while until do done case esac function declare local typeset let shift trap time nice ionice stdbuf".split(
    " ",
  ),
);
export function activityProgramName(input: Record<string, unknown>): string | undefined {
  if (typeof input.command !== "string") return undefined;
  const lines = input.command
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines[0];
  if (lines.length !== 1 || !line || /[`$|&;<>()[\]{}"'\\=!*?~#^]/.test(line)) return undefined;
  const token = line.split(/\s+/)[0] ?? "";
  const name = token.split(/[\\/]/).at(-1) ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) || DENY.has(name.toLowerCase())) return undefined;
  return trim(name, 40);
}
