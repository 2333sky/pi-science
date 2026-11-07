import { meaningfulActivityTitle, presentToolActivity, shellCommandPreview } from "../../../lib/conversation/activity-presenters";
import { toolDetails } from "./ToolDetails";
import type { ActivityRenderer } from "./types";

export const GenericActivityRenderer: ActivityRenderer = {
  compact: ({ source, t }) => {
    const title = presentToolActivity(source, t);
    if (source.tool.trim().toLowerCase() !== "bash") return { title };
    const command = typeof source.input?.command === "string" ? shellCommandPreview(source.input.command) : "";
    const label = t(source.status === "running" ? "conversation.activity.terminalRunning" : "conversation.activity.terminal");
    const summary = command
      ? title.includes(command) ? command : title
      : meaningfulActivityTitle(source.presentation?.title, source.tool)
        ?? meaningfulActivityTitle(source.title, source.tool)
        ?? (typeof source.input?.description === "string" ? source.input.description.trim() : "");
    return { title: label, ...(summary ? { detail: summary } : {}) };
  },
  expanded: toolDetails,
};
