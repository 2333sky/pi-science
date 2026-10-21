import { useTranslation } from "react-i18next";
import type { DiscoveredModel } from "./useModelDiscovery";

/** Shared discovery result list: connected models start selected because the connection exists to use them. */
export function DiscoveryList({ models, selected, onChange }: { models: DiscoveredModel[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const chosen = models.filter((model) => selected.includes(model.id)).length;
  const allSelected = models.length > 0 && chosen === models.length;
  return <div className="overflow-hidden rounded-input border border-border">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-faint px-3 py-2">
      <span className="text-ui-caption tabular-nums text-muted">{t("settings.connections.discovery.summary", { found: models.length, selected: chosen })}</span>
      <button type="button" className="text-ui-caption text-link" onClick={() => onChange(allSelected ? [] : models.map((model) => model.id))}>{t(allSelected ? "settings.connections.discovery.clearAll" : "settings.connections.discovery.selectAll")}</button>
    </div>
    <ul className="max-h-56 overflow-y-auto py-1">{models.map((model) => {
      const label = model.display_name && model.display_name !== model.id ? model.display_name : model.id;
      return <li key={model.id}><label className="flex min-h-9 cursor-pointer items-center gap-2 px-3 hover:bg-surface-hover"><input type="checkbox" checked={selected.includes(model.id)} onChange={(e) => onChange(e.target.checked ? [...selected, model.id] : selected.filter((id) => id !== model.id))} /><span className="min-w-0 flex-1 truncate text-ui-caption text-text">{label}</span>{label !== model.id && <span className="shrink-0 font-mono text-ui-meta text-muted">{model.id}</span>}</label></li>;
    })}</ul>
  </div>;
}
