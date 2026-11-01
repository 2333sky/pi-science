import { FileText, FolderTree, Globe, Pencil, Search, Terminal, Wrench, type LucideIcon } from "lucide-react";
import { toolActivityCategory, type ActivityToolCategory } from "../../../lib/conversation/activity-presenters";
import { cn } from "../../../lib/ui";

/** One glyph per kind of step, so the row answers "what happened" before its
 *  label is read: reading a file, searching, listing, editing, reaching the
 *  web, running a program. The sets live in the presenter, so a glyph cannot
 *  claim a category the wording does not. */
export const ACTIVITY_CATEGORY_ICONS: Record<ActivityToolCategory, LucideIcon> = {
  read: FileText, search: Search, list: FolderTree, write: Pencil, web: Globe, run: Terminal, other: Wrench,
};

/** A finished step's marker. The wrapper keeps the 14px column the running dot
 *  and the error glyph occupy, so every row's label starts on the same line. */
export function ActivityCategoryIcon({ tool, size = 14, className }: { tool: string; size?: number; className?: string }) {
  const category = toolActivityCategory(tool);
  const Icon = ACTIVITY_CATEGORY_ICONS[category];
  return <span data-activity-category={category} className={cn("flex shrink-0 items-center justify-center", className)}><Icon size={size} aria-hidden /></span>;
}
