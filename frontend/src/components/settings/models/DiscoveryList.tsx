import { useTranslation } from "react-i18next";
import { DEFAULT_MODEL_CONTEXT_WINDOW } from "@pi-science/contracts";
import type { DiscoveredModel } from "./useModelDiscovery";
import type { ModelConfigEdits } from "./model-utils";

// The context field must show seven digits, and Chromium reserves room for spinners inside a number input.
const cell = "h-6 shrink-0 rounded-small border border-border bg-bg px-1.5 text-right text-ui-meta tabular-nums text-text outline-none focus:border-accent [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";
const numeric = (raw: string) => { const parsed = Math.round(Number(raw)); return Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined; };

/** Shared discovery result list: connected models start selected because the connection exists to use them.
 *  Each row also corrects the capabilities the endpoint under-reported; `edits` holds those corrections. */
export function DiscoveryList({ models, selected, onChange, edits, onEdits }: { models: DiscoveredModel[]; selected: string[]; onChange: (ids: string[]) => void; edits: Record<string, ModelConfigEdits>; onEdits: (edits: Record<string, ModelConfigEdits>) => void }) {
  const { t } = useTranslation();
  const chosen = models.filter((model) => selected.includes(model.id)).length;
  const allSelected = models.length > 0 && chosen === models.length;
  const edit = (id: string, patch: ModelConfigEdits) => onEdits({ ...edits, [id]: { ...edits[id], ...patch } });
  return <div className="overflow-hidden rounded-input border border-border">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-faint px-3 py-2">
      <span className="text-ui-caption tabular-nums text-muted">{t("settings.connections.discovery.summary", { found: models.length, selected: chosen })}</span>
      <button type="button" className="text-ui-caption text-link" onClick={() => onChange(allSelected ? [] : models.map((model) => model.id))}>{t(allSelected ? "settings.connections.discovery.clearAll" : "settings.connections.discovery.selectAll")}</button>
    </div>
    <div className="hidden items-center gap-2 border-b border-faint px-3 py-1 text-ui-micro text-muted sm:flex">
      <span className="min-w-0 flex-1">{t("settings.native.colModel")}</span>
      <span className="w-20 text-right">{t("settings.native.colContext")}</span>
      <span className="w-16 text-right">{t("settings.native.colOutput")}</span>
      <span className="w-14 text-center">{t("settings.native.colInput")}</span>
      <span className="w-9 text-center">{t("settings.native.colThinking")}</span>
    </div>
    <ul className="max-h-56 overflow-y-auto py-1">{models.map((model) => {
      const label = model.display_name && model.display_name !== model.id ? model.display_name : model.id;
      const capabilities = model.capabilities ?? {}, current = edits[model.id] ?? {};
      const usingDefault = !current.contextWindow && !capabilities.context_window;
      const images = (current.input ?? (capabilities.vision ? ["text", "image"] : ["text"])).includes("image");
      const reasoning = current.reasoning ?? capabilities.reasoning ?? false;
      return <li key={model.id} className="flex min-h-12 flex-wrap items-center gap-2 px-3 py-1 hover:bg-surface-hover">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" title={model.id}>
          <input type="checkbox" checked={selected.includes(model.id)} onChange={(e) => onChange(e.target.checked ? [...selected, model.id] : selected.filter((id) => id !== model.id))} />
          <span className="min-w-0 truncate text-ui-caption text-text">{label}</span>
        </label>
        <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
          <input type="number" min={1} className={`${cell} w-20 ${usingDefault ? "italic text-muted" : ""}`} title={usingDefault ? t("settings.native.defaultValue") : undefined} aria-label={`${label} ${t("settings.native.colContext")}`} value={current.contextWindow ?? capabilities.context_window ?? DEFAULT_MODEL_CONTEXT_WINDOW} onChange={(e) => edit(model.id, { contextWindow: numeric(e.target.value) })} />
          <input type="number" min={1} className={`${cell} w-16`} aria-label={`${label} ${t("settings.native.colOutput")}`} value={current.maxTokens ?? capabilities.max_output_tokens ?? ""} placeholder="—" onChange={(e) => edit(model.id, { maxTokens: numeric(e.target.value) })} />
          <button type="button" aria-pressed={images} aria-label={`${label} ${t("settings.native.colInput")}`} className={`h-6 w-14 shrink-0 rounded-small border text-ui-micro ${images ? "border-accent bg-accent-soft text-text" : "border-border text-muted"}`} onClick={() => edit(model.id, { input: images ? ["text"] : ["text", "image"] })}>{t(`settings.native.input.${images ? "image" : "text"}`)}</button>
          <button type="button" role="switch" aria-checked={reasoning} aria-label={`${label} ${t("settings.native.colThinking")}`} className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${reasoning ? "border-accent bg-accent-fill" : "border-border bg-surface-inset"}`} onClick={() => edit(model.id, { reasoning: !reasoning })}><span aria-hidden="true" className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full ${reasoning ? "right-0.5 bg-accent-fg" : "left-0.5 bg-muted"}`} /></button>
        </div>
      </li>;
    })}</ul>
  </div>;
}
