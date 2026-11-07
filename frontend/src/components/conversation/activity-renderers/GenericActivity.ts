import { meaningfulActivityTitle, presentToolActivity, shellCommandPreview } from "../../../lib/conversation/activity-presenters";
import { toolDetails } from "./ToolDetails";
import type { ActivityRenderer } from "./types";

export const GenericActivityRenderer: ActivityRenderer = {
  compact: ({ source, t }) => {
    const title = presentToolActivity(source, t);
    if (source.tool.trim().toLowerCase() !== "bash") return { title };
    const command = typeof source.input?.command === "string" ? shellCommandPreview(source.input.command) : "";
    const description = typeof source.input?.description === "string" ? source.input.description.trim() : "";
    const task = description
      || source.presentation?.description?.trim()
      || meaningfulActivityTitle(source.presentation?.title, source.tool)
      || meaningfulActivityTitle(source.title, source.tool);
    return { title: task || command || t(source.status === "running" ? "conversation.activity.terminalRunning" : "conversation.activity.terminal") };
  },
  expanded: toolDetails,
};
