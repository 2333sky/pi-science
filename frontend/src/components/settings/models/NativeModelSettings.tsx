import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight, Ellipsis, PlugZap, Search } from "lucide-react";
import type { ProviderConfig } from "@pi-science/contracts";
import { apiRequest, ApiError } from "../../../lib/client/api";
import { Modal } from "../../ui/Modal";
import { ConnectModelService, CredentialFields } from "./ConnectModelService";
import { button, field, primary, send, useModelConfig, type CatalogProvider } from "./native-model-api";
import { formatContext } from "./model-utils";
export { useModelConfig } from "./native-model-api";

type Dialog = { kind: "credential" | "details" | "disconnect" | "edit" | "refresh"; provider: CatalogProvider } | { kind: "connect"; revision: number } | { kind: "advanced"; revision: number };

export function NativeModelSettings({ onConfigReload }: { onConfigReload?: () => Promise<void> }) {
  const { t } = useTranslation();
  const configuration = useModelConfig();
  const client = useQueryClient();
  const catalog = useQuery({ queryKey: ["model-config", "catalog"], queryFn: () => apiRequest<{ providers: CatalogProvider[]; revision: number }>("/api/model-config/catalog"), retry: false });
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ["model-config"] }), client.invalidateQueries({ queryKey: ["settings"] }), client.invalidateQueries({ queryKey: ["model-resources"] })]);
  };
  const committed = async (result?: { runtime?: string }) => {
    setDialog(null);
    setNotice(t(result?.runtime === "reload_pending" ? "settings.native.reloadPending" : "settings.native.saved"));
    try { await refresh(); await onConfigReload?.(); } catch { setNotice(t("settings.native.reloadPending")); }
  };
  const failed = async (cause: unknown) => { if (cause instanceof ApiError && cause.status === 409) await refresh(); };
  const connected = (catalog.data?.providers ?? []).filter((p) => p.configured);
  const providers = connected.filter((p) => `${p.name} ${p.id} ${p.models.map((m) => m.id).join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(providers.length / 20) - 1));
  const revision = configuration.data?.revision;
  const canConnect = revision !== undefined && !configuration.error && Boolean(catalog.data) && !catalog.error;
  return <div className="space-y-5">
    <header className="flex items-start justify-between gap-4">
      <p className="text-ui-caption text-muted">{t("settings.native.scope")}</p>
      {connected.length > 0 && <button className={primary} disabled={!canConnect} onClick={() => setDialog({ kind: "connect", revision: revision! })}><PlugZap size={14} className="mr-1 inline" />{t("settings.models.connect")}</button>}
    </header>
    {(catalog.isPending || configuration.isPending) && <p role="status">{t("common.loading")}</p>}
    {(catalog.error || configuration.error) && <p role="alert" className="text-ui-caption text-error-text">{catalog.error?.message ?? configuration.error?.message}<button className={`${button} ml-2`} onClick={() => void refresh()}>{t("settings.redesign.retryLoad")}</button></p>}
    {notice && <p role="status" className="text-ui-caption text-muted">{notice}</p>}
    <section aria-labelledby="connected-services-title" className="space-y-3">
      <h3 id="connected-services-title" className="text-ui-label font-medium text-text">{t("settings.connections.myServices")}</h3>
      {connected.length > 0 && <label className="flex items-center gap-2 rounded-input border border-border bg-bg px-3"><Search size={16} className="text-muted" /><input className="min-h-10 min-w-0 flex-1 bg-transparent text-ui-label text-text outline-none" aria-label={t("settings.redesign.searchModels")} placeholder={t("settings.redesign.searchModels")} value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} /></label>}
      {canConnect && connected.length === 0 && <div className="border-y border-faint py-10 text-center"><PlugZap className="mx-auto mb-3 text-muted" size={24} /><p className="text-sm font-medium text-text">{t("settings.models.emptyTitle")}</p><p className="mt-1 text-ui-caption text-muted">{t("settings.models.emptyDescription")}</p><button className={`${primary} mt-4`} onClick={() => setDialog({ kind: "connect", revision: revision! })}>{t("settings.models.connectService")}</button></div>}
      {connected.length > 0 && !providers.length && <p className="text-ui-caption text-muted">{t("settings.redesign.noMatchingModels")}</p>}
      {providers.slice(currentPage * 20, (currentPage + 1) * 20).map((provider) => {
        const count = provider.models.filter((m) => m.available).length;
        const ready = count > 0;
        return <section key={provider.id} className="rounded-card border border-border bg-surface-1 px-4">
          <div className="flex items-center gap-2 py-3">
            <button className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left" aria-label={provider.name} aria-expanded={Boolean(expanded[provider.id])} aria-controls={`models-${provider.id}`} onClick={() => setExpanded((v) => ({ ...v, [provider.id]: !v[provider.id] }))}>
              <ChevronRight size={16} className={expanded[provider.id] ? "shrink-0 rotate-90 text-muted" : "shrink-0 text-muted"} /><span className="min-w-0"><span className="block break-words text-ui-label font-medium text-text">{provider.name}</span><span className="block text-ui-meta text-muted">{t(provider.source === "user" ? "settings.connections.customApi" : "settings.connections.api")} · {count} / {provider.models.length}</span></span>
            </button>
            <span className={`text-ui-meta ${ready ? "text-muted" : "text-error-text"}`}>{t(ready ? "settings.connections.ready" : "settings.connections.attention")}</span>
            <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="min-h-9 min-w-9 rounded-input text-muted hover:bg-surface-hover" id={`provider-actions-${provider.id}`} aria-label={t("settings.connections.actions", { name: provider.name })}><Ellipsis className="mx-auto" size={18} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content onCloseAutoFocus={(e) => { if (dialog) e.preventDefault(); }} align="end" className="z-[120] min-w-44 rounded-card border border-border bg-surface-raised p-1 shadow-pop">
              {(["credential", "edit", "refresh", "details", "disconnect"] as const).filter((action) => provider.allowed_actions.includes(action)).map((action) => <DropdownMenu.Item key={action} className="cursor-pointer rounded-input px-3 py-2 text-ui-caption text-text outline-none focus:bg-surface-hover" onSelect={() => { document.getElementById(`provider-actions-${provider.id}`)?.focus(); setDialog({ kind: action, provider }); }}>{t(`settings.connections.${action}`)}</DropdownMenu.Item>)}
            </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
          </div>
          <p className="pb-3 text-ui-meta text-muted">{t(`settings.native.source.${provider.authentication.source}`)}{provider.authentication.environment_variable ? `: ${provider.authentication.environment_variable}` : ""}</p>
          {provider.authentication.restart_required && <p className="pb-3 text-ui-caption text-muted">{t("settings.native.restart")}</p>}
          {expanded[provider.id] && <div id={`models-${provider.id}`} role="region" aria-label={`${provider.name} ${t("settings.models.models")}`} className="border-t border-faint py-3"><NativeModels key={search} models={`${provider.name} ${provider.id}`.toLowerCase().includes(search.toLowerCase()) ? provider.models : provider.models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(search.toLowerCase()))} /></div>}
        </section>;
      })}
      {providers.length > 20 && <div className="flex gap-2"><button className={button} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("settings.redesign.previousPage")}</button><button className={button} disabled={(currentPage + 1) * 20 >= providers.length} onClick={() => setPage(currentPage + 1)}>{t("settings.redesign.nextPage")}</button></div>}
    </section>
    <button className="min-h-9 text-ui-caption text-muted hover:text-text disabled:opacity-40" disabled={!canConnect} onClick={() => setDialog({ kind: "advanced", revision: revision! })}>{t("settings.native.edit")}</button>
    {dialog?.kind === "connect" && <ConnectModelService providers={catalog.data?.providers ?? []} revision={dialog.revision} onClose={() => setDialog(null)} onSaved={committed} onFailure={failed} />}
    {dialog && dialog.kind !== "connect" && <ManageDialog key={dialog.kind === "advanced" ? "advanced" : `${dialog.kind}-${dialog.provider.id}`} dialog={dialog} config={configuration.data?.config ?? { providers: {} }} onClose={() => setDialog(null)} onSaved={committed} onFailure={failed} />}
  </div>;
}

function ManageDialog({ dialog, config, onClose, onSaved, onFailure }: { dialog: Exclude<Dialog, { kind: "connect" }>; config: { providers: Record<string, ProviderConfig> }; onClose: () => void; onSaved: (result?: { runtime?: string }) => Promise<void>; onFailure: (cause: unknown) => Promise<void> }) {
  const { t } = useTranslation();
  const p = dialog.kind === "advanced" ? null : dialog.provider;
  const [source, setSource] = useState<string>(["managed", "environment", "keyless"].includes(p?.authentication.source ?? "") ? p!.authentication.source : "managed"); const [secret, setSecret] = useState(""); const [variable, setVariable] = useState(p?.authentication.environment_variable ?? "");
  const [editor, setEditor] = useState(JSON.stringify(config, null, 2)); const [previewed, setPreviewed] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(p?.name ?? ""); const [url, setUrl] = useState(p?.config?.baseUrl ?? "");
  const [api, setApi] = useState(p?.config?.api ?? "openai-completions"); const [models, setModels] = useState(p?.config?.models?.map((m) => m.id).join("\n") ?? "");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [discard, setDiscard] = useState(false); const [touched, setTouched] = useState(false);
  const dirty = touched || Boolean(secret || previewed || p && (name !== p.name || url !== (p.config?.baseUrl ?? "") || models !== (p.config?.models?.map((m) => m.id).join("\n") ?? "")) || dialog.kind === "advanced" && editor !== JSON.stringify(config, null, 2));
  const close = () => { if (!busy) { if (dirty) setDiscard(true); else onClose(); } };
  const run = async (action: () => Promise<{ runtime?: string }>, save = true) => {
    setBusy(true); setError(null);
    try { const result = await action(); if (save) { setSecret(""); await onSaved(result); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await onFailure(cause); }
    finally { setBusy(false); }
  };
  const save = () => run(async () => {
    if (dialog.kind === "advanced") return send("/api/model-config", "PUT", { revision: dialog.revision, config: JSON.parse(editor) });
    const path = `/api/model-config/providers/${encodeURIComponent(p!.id)}`;
    if (dialog.kind === "disconnect") return send(path, "DELETE", { revision: p!.revision });
    if ((dialog.kind === "edit" || dialog.kind === "refresh")) {
      const ids = [...new Set(models.split("\n").map((s) => s.trim()).filter(Boolean))];
      const original = p!.config!;
      const next = { ...original, name, baseUrl: url, api, models: ids.map((id) => original.models?.find((m) => m.id === id) ?? { id }), modelOverrides: Object.fromEntries(Object.entries(original.modelOverrides ?? {}).filter(([id]) => ids.includes(id))) };
      await send("/api/model-config/preview", "POST", { providers: { ...config.providers, [p!.id]: next } });
      return send(path, "PATCH", { revision: p!.revision, config: next });
    }
    return send(`${path}/credential`, "PUT", { revision: p!.revision, credential: source === "managed" ? { source, secret } : source === "environment" ? { source, environment_variable: variable } : { source } });
  });
  const title = dialog.kind === "advanced" ? t("settings.native.edit") : `${p!.name} · ${t(`settings.connections.${dialog.kind}`)}`;
  return <Modal title={title} onClose={close} restoreFocusTo={p ? document.getElementById(`provider-actions-${p.id}`) : undefined} footer={<div className="flex justify-end gap-2"><button className={button} disabled={busy} onClick={close}>{t("common.cancel")}</button>{dialog.kind !== "details" && <button className={primary} disabled={busy || dialog.kind === "advanced" && !previewed || dialog.kind === "credential" && (source === "managed" && !secret.trim() || source === "environment" && !variable.trim()) || (dialog.kind === "edit" || dialog.kind === "refresh") && (!models.trim() || !name.trim() || !url.trim())} onClick={() => void save()}>{t(dialog.kind === "disconnect" ? "settings.connections.disconnect" : "common.save")}</button>}</div>}>
    <div className="space-y-3 text-ui-caption text-text" onChange={() => setTouched(true)}>
      {dialog.kind === "credential" && <CredentialFields capabilities={p!.auth_capabilities} source={source} setSource={(v) => { setSource(v); setSecret(""); }} secret={secret} setSecret={setSecret} variable={variable} setVariable={setVariable} allowRemove />}
      {dialog.kind === "disconnect" && <p>{t("settings.connections.disconnectHelp", { name: p!.name })}</p>}
      {dialog.kind === "details" && <><p>{p!.id}</p><p>{p!.config?.baseUrl}</p><p>{p!.config?.api}</p><p>{t(`settings.native.source.${p!.authentication.source}`)}</p><p>{t("settings.native.discoveryHelp")}</p></>}
      {(dialog.kind === "edit" || dialog.kind === "refresh") && <><button className={button} disabled={busy} onClick={() => void run(async () => { const found = await send<{ models: Array<{ id: string }> }>(`/api/model-config/providers/${encodeURIComponent(p!.id)}/discover`, "POST", {}); setCandidates([...new Set(found.models.map((m) => m.id))]); return {}; }, false)}>{t("settings.native.discover")}</button><p className="text-muted">{t("settings.native.discoveryHelp")}</p>{candidates.map((id) => <label key={id} className="flex gap-2 break-all"><input type="checkbox" checked={models.split("\n").includes(id)} onChange={(e) => setModels((v) => e.target.checked ? `${v}\n${id}` : v.split("\n").filter((m) => m !== id).join("\n"))} />{id}</label>)}{([["settings.resources.name", name, setName], ["settings.resources.baseUrl", url, setUrl]] as const).map(([label, value, update]) => <label key={label} className="block">{t(label)}<input className={field} value={value} onChange={(e) => update(e.target.value)} /></label>)}<label className="block">{t("settings.native.api")}<select className={field} value={api} onChange={(e) => setApi(e.target.value as typeof api)}>{["openai-completions", "openai-responses", "anthropic-messages"].map((v) => <option key={v}>{v}</option>)}</select></label><label className="block">{t("settings.native.manualModels")}<textarea className={field} rows={4} value={models} onChange={(e) => setModels(e.target.value)} /></label></>}
      {dialog.kind === "advanced" && <><p className="text-muted">{t("settings.native.editorHelp")}</p><textarea className={`${field} font-mono`} rows={16} aria-label={t("settings.native.edit")} value={editor} onChange={(e) => { setEditor(e.target.value); setPreviewed(false); }} /><button className={button} disabled={busy} onClick={() => void run(async () => { await send("/api/model-config/preview", "POST", JSON.parse(editor)); setPreviewed(true); return {}; }, false)}>{t("settings.native.validate")}</button></>}
      {error && <p role="alert" className="text-error-text">{error}</p>}
      {discard && <div role="alert" className="space-y-2"><p>{t("settings.connections.discardHelp")}</p><button className={button} onClick={() => setDiscard(false)}>{t("settings.connections.keepEditing")}</button><button className={`${button} ml-2`} onClick={onClose}>{t("settings.connections.discard")}</button></div>}
    </div>
  </Modal>;
}

function NativeModels({ models }: { models: CatalogProvider["models"] }) {
  const { t } = useTranslation(); const [page, setPage] = useState(0);
  return <div className="space-y-2 text-ui-caption">{models.slice(page * 50, (page + 1) * 50).map((model) => <div key={model.id} className="flex justify-between gap-3 border-b border-faint py-2 text-muted"><span className="break-words text-text">{model.name}<span className="block text-ui-meta text-muted">{t("settings.models.contextWindow")}: {formatContext(model.contextWindow)} · {t("settings.models.maxOutputTokens")}: {formatContext(model.maxTokens ?? null)}<br />{model.input?.join(" · ")} · {t("settings.redesign.supportedThinking")}: {model.thinking_levels?.join(" · ") || t("settings.native.unknown")}</span></span><span>{t(model.available ? "settings.native.selectable" : "settings.native.unavailable")}</span></div>)}{models.length > 50 && <div className="flex gap-2"><button className={button} disabled={page === 0} onClick={() => setPage(page - 1)}>{t("settings.redesign.previousPage")}</button><button className={button} disabled={(page + 1) * 50 >= models.length} onClick={() => setPage(page + 1)}>{t("settings.redesign.nextPage")}</button></div>}</div>;
}
