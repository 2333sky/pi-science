import { presentToolActivity, shellCommandPreview } from "../../../lib/conversation/activity-presenters";
import { toolDetails } from "./ToolDetails";
import type { ActivityRenderer } from "./types";

export const GenericActivityRenderer: ActivityRenderer = {
  compact: ({ source, t }) => {
    const title = presentToolActivity(source, t);
    const command = source.tool.trim().toLowerCase() === "bash" && typeof source.input?.command === "string"
      ? shellCommandPreview(source.input.command)
      : "";
    return { title, ...(command && !title.includes(command) ? { detail: command } : {}) };
  },
  expanded: toolDetails,
};
