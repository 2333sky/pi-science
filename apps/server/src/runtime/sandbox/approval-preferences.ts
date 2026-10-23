import { approvalPreferencesSchema } from "@pi-science/contracts";
import { SettingsStore } from "../../storage/settings-store.js";

export function approvalPreferences(config: { approval_preferences?: unknown }) {
  const parsed = approvalPreferencesSchema.safeParse(config.approval_preferences ?? {});
  return parsed.success ? parsed.data : { defaultMode: "ask" as const };
}
export async function defaultSessionApproval() {
  return { mode: approvalPreferences(await new SettingsStore().read()).defaultMode };
}
