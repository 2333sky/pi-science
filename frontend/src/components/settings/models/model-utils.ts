import { DEFAULT_MODEL_CONTEXT_WINDOW, type ProviderConfig, type ProviderView } from "@pi-science/contracts";
import type { DiscoveredModel } from "./useModelDiscovery";

export type ModelView = {
  id: string;
  name: string;
  vendor?: string;
  reasoning: boolean;
  inputFormats: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  vision?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  thinkingLevels: string[];
  source?: string;
  available?: boolean;
  reason?: string;
};

export type Service = {
  id: string;
  name: string;
  status: ProviderView["status"];
  models: ModelView[];
  custom: boolean;
  auth?: ProviderView["auth"];
  view: ProviderView;
  provider?: Pick<ProviderView, "id" | "name">;
};

/** Adapt presentation fields only: availability and actions are backend facts. */
export function buildServices(providers: ProviderView[]): Service[] {
  return providers.map((view) => ({
    id: view.id, name: view.name, custom: view.source === "user", status: view.status,
    auth: view.auth, provider: { id: view.id, name: view.name }, view,
    models: view.models.map((model) => ({ id: model.id, name: shortModelName(model.display_name, model.model_id), reasoning: model.capabilities.reasoning,
      inputFormats: model.input_formats ?? [], contextWindow: model.capabilities.context_window, maxOutputTokens: model.capabilities.max_output_tokens,
      vision: model.capabilities.vision, tools: model.capabilities.tools, structuredOutput: model.capabilities.structured_output,
      thinkingLevels: model.capabilities.thinking_levels, source: model.capability_source, available: model.available, reason: model.availability_reason })),
  }));
}

export function shortModelName(label: string, model: string) {
  const separator = label.indexOf("·");
  return separator >= 0 ? label.slice(separator + 1).trim() || model : label || model;
}

export function formatContext(value: number | null) {
  if (!value) return "—";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

/** Capabilities the user corrected in the discovery list. Absent keys stay undeclared. */
export type ModelConfigEdits = { contextWindow?: number; maxTokens?: number; input?: Array<"text" | "image">; reasoning?: boolean };

/** Maps the capabilities a provider advertised during discovery onto the configuration
 *  schema. The user's edit wins, then the declaration, then for `contextWindow` the one
 *  default the discovery list also shows. Pi hides `xhigh` and `max` unless a thinking
 *  map entry exists, so a reasoning model gets both levels routed to `high`. */
export function modelConfigFromDiscovery(model?: DiscoveredModel, edits: ModelConfigEdits = {}) {
  const capabilities = model?.capabilities ?? {};
  const reasoning = edits.reasoning ?? capabilities.reasoning;
  const contextWindow = edits.contextWindow ?? capabilities.context_window ?? (model ? DEFAULT_MODEL_CONTEXT_WINDOW : undefined);
  const maxTokens = edits.maxTokens ?? capabilities.max_output_tokens;
  const input = edits.input ?? (capabilities.vision ? ["text", "image"] as Array<"text" | "image"> : undefined);
  return {
    ...(model?.display_name && model.display_name !== model.id ? { name: model.display_name } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(input ? { input } : {}),
    ...(reasoning ? { thinkingLevelMap: { xhigh: "high", max: "high" } } : {}),
  };
}

/** Discovery owns the capability fields it reports, so a refresh rewrites them on models that
 *  already exist. Manual corrections belong in `modelOverrides`, which this never touches. */
export function mergeDiscoveredModels(existing: NonNullable<ProviderConfig["models"]>, discovered: DiscoveredModel[], edits: Record<string, ModelConfigEdits> = {}) {
  const byId = new Map(discovered.map((model) => [model.id, model]));
  let updated = 0;
  const models = existing.map((model) => {
    const found = byId.get(model.id);
    if (!found) return model;
    const patch = modelConfigFromDiscovery(found, edits[model.id]);
    if (!Object.keys(patch).length) return model;
    updated += 1;
    return { ...model, ...patch, ...(model.name ? { name: model.name } : {}) };
  });
  const known = new Set(existing.map((model) => model.id));
  const added = discovered.filter((model) => !known.has(model.id)).map((model) => ({ id: model.id, ...modelConfigFromDiscovery(model, edits[model.id]) }));
  return { models: [...models, ...added], added: added.length, updated };
}
