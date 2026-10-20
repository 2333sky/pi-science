import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Plus, Search } from "lucide-react";
import type { ProviderAuthCapabilities } from "@pi-science/contracts";
import { Modal } from "../../ui/Modal";
import { button, field, primary, send, type CatalogProvider } from "./native-model-api";

type Result = { runtime?: string };
type Target = CatalogProvider | "custom" | null;
export function ConnectModelService({ providers, revision, onClose, onSaved, onFailure }: { providers: CatalogProvider[]; revision: number; onClose: () => void; onSaved: (result?: Result) => Promise<void>; onFailure: (cause: unknown) => Promise<void> }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState("api"); const [target, setTarget] = useState<Target>(null);
  const [search, setSearch] = useState(""); const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false);
  const [canSave, setCanSave] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null); const [generation, setGeneration] = useState(0);
  const id = useId();
  const transition = (action: () => void) => { if (busy) return; if (dirty) setPending(() => action); else action(); };
  const clearDraft = () => { setDirty(false); setGeneration((g) => g + 1); };
  const changeTab = (value: string) => transition(() => { clearDraft(); setTab(value); });
  const selectable = providers.filter((p) => p.auth_capabilities.api_key && !p.configured && `${p.name} ${p.id}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  return <Modal title={t("settings.connections.connectTitle")} onClose={() => transition(onClose)} contentClassName="h-[min(620px,calc(100dvh-32px))] w-[min(600px,calc(100vw-32px))] max-h-none" bodyClassName="flex flex-col overflow-hidden p-0" footer={<div className="flex min-h-9 items-center justify-end gap-2">{pending ? <><span className="mr-auto text-ui-caption text-muted">{t("settings.connections.discardHelp")}</span><button className={button} onClick={() => setPending(null)}>{t("settings.connections.keepEditing")}</button><button className={primary} onClick={() => { clearDraft(); pending(); setPending(null); }}>{t("settings.connections.discard")}</button></> : <><button className={button} disabled={busy} onClick={() => transition(onClose)}>{t("common.cancel")}</button>{tab === "api" && target && <button form={`${id}-form`} type="submit" className={primary} disabled={busy || !canSave}>{t("common.save")}</button>}</>}</div>}>
    <div role="tablist" aria-label={t("settings.connections.method")} className="flex shrink-0 gap-1 border-b border-faint px-5 pt-2">
      {["api", "subscription"].map((value, index) => <button key={value} id={`${id}-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`${id}-panel`} tabIndex={tab === value ? 0 : -1} disabled={busy} className={`min-h-10 border-b-2 px-4 text-ui-label ${tab === value ? "border-accent text-text" : "border-transparent text-muted"}`} onClick={() => changeTab(value)} onKeyDown={(e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); const next = e.key === "Home" ? "api" : e.key === "End" ? "subscription" : index === 0 ? "subscription" : "api"; changeTab(next); document.getElementById(`${id}-${next}`)?.focus(); } }}>{t(`settings.connections.${value}`)}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {tab === "subscription" ? <div className="flex min-h-64 flex-col justify-center text-center"><p className="text-ui-label font-medium text-text">{t("settings.connections.subscriptionUnavailable")}</p><p className="mt-2 text-ui-caption text-muted">{t("settings.connections.subscriptionHelp")}</p></div> : target ? <div className="space-y-4"><button className="flex min-h-9 items-center gap-1 text-ui-caption text-link" disabled={busy} onClick={() => transition(() => { clearDraft(); setTarget(null); })}><ArrowLeft size={14} />{t("settings.connections.back")}</button><h3 className="text-ui-label font-medium text-text">{target === "custom" ? t("settings.connections.customApi") : target.name}</h3><ApiForm key={`${generation}-${target === "custom" ? "custom" : target.id}`} formId={`${id}-form`} target={target} providers={providers} revision={revision} onDirty={setDirty} onBusy={setBusy} onCanSave={setCanSave} onSaved={onSaved} onFailure={onFailure} /></div> : <div className="space-y-4">
        <button className="flex min-h-16 w-full items-center gap-3 rounded-card border border-accent bg-accent/5 px-4 text-left text-ui-label font-medium text-text" onClick={() => setTarget("custom")}><Plus size={20} className="text-link" />{t("settings.connections.addCustom")}</button>
        <label className="flex items-center gap-2 rounded-input border border-border bg-bg px-3"><Search size={16} className="text-muted" /><input className="min-h-10 min-w-0 flex-1 bg-transparent text-ui-caption text-text outline-none" aria-label={t("settings.connections.searchProviders")} placeholder={t("settings.connections.searchProviders")} value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <div className="space-y-1">{selectable.map((p) => <button key={p.id} className="flex min-h-12 w-full items-center justify-between rounded-input px-3 text-left hover:bg-surface-hover" onClick={() => setTarget(p)}><span className="text-ui-label text-text">{p.name}<span className="ml-2 text-ui-meta text-muted">{p.id}</span></span><Plus size={14} className="shrink-0 text-muted" /></button>)}</div>
        {!selectable.length && <p role="status" className="text-ui-caption text-muted">{t("settings.connections.noProviders")}</p>}
      </div>}
    </div>
  </Modal>;
}

export function CredentialFields({ capabilities, source, setSource, secret, setSecret, variable, setVariable, allowRemove = false }: { capabilities: ProviderAuthCapabilities; source: string; setSource: (s: string) => void; secret: string; setSecret: (s: string) => void; variable: string; setVariable: (s: string) => void; allowRemove?: boolean }) {
  const { t } = useTranslation();
  const sources = [...(capabilities.api_key ? ["managed"] : []), ...(capabilities.environment ? ["environment"] : []), ...(capabilities.keyless ? ["keyless"] : []), ...(allowRemove ? ["remove"] : [])];
  return <div className="space-y-3"><label className="block text-ui-caption text-text">{t("settings.native.authSource")}<select className={field} value={source} onChange={(e) => setSource(e.target.value)}>{sources.map((s) => <option key={s} value={s}>{t(`settings.native.source.${s}`)}</option>)}</select></label>
    {source === "managed" && <label className="block text-ui-caption text-text">{t("settings.resources.apiKey")}<input className={field} type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} required /></label>}
    {source === "environment" && <label className="block text-ui-caption text-text">{t("settings.native.envName")}<input className={field} value={variable} onChange={(e) => setVariable(e.target.value)} pattern="[A-Za-z_][A-Za-z0-9_]*" required /><span className="text-muted">{t("settings.native.restart")}</span></label>}
  </div>;
}

function ApiForm({ target, providers, revision, formId, onDirty, onBusy, onCanSave, onSaved, onFailure }: { target: Exclude<Target, null>; providers: CatalogProvider[]; revision: number; formId: string; onDirty: (v: boolean) => void; onBusy: (v: boolean) => void; onCanSave: (v: boolean) => void; onSaved: (r?: Result) => Promise<void>; onFailure: (cause: unknown) => Promise<void> }) {
  const { t } = useTranslation(); const custom = target === "custom";
  const [name, setName] = useState(""); const [id, setId] = useState(""); const [url, setUrl] = useState(""); const [api, setApi] = useState("openai-completions");
  const [source, setSource] = useState("managed"); const [secret, setSecret] = useState(""); const [variable, setVariable] = useState("");
  const [manual, setManual] = useState(""); const [candidates, setCandidates] = useState<string[]>([]); const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const requestGeneration = useRef(0);
  const capabilities = custom ? { api_key: true, environment: true, keyless: true, subscription: false } : target.auth_capabilities;
  const valid = (source === "managed" ? Boolean(secret.trim()) : source === "environment" ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) : true) && (!custom || Boolean(name.trim() && id && url && (selected.length || manual.trim())));
  useEffect(() => { onCanSave(valid); }, [valid, onCanSave]);
  const invalidate = () => { requestGeneration.current++; setCandidates([]); setSelected([]); };
  const execute = async (action: () => Promise<void>) => {
    setBusy(true); onBusy(true); setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await onFailure(cause); }
    finally { setBusy(false); onBusy(false); }
  };
  const discover = () => execute(async () => {
    const generation = ++requestGeneration.current;
    const result = await send<{ models: Array<{ id: string }> }>("/api/model-config/discover", "POST", { base_url: url, api, ...(source === "managed" && secret ? { secret } : {}) });
    if (generation === requestGeneration.current) { setCandidates([...new Set(result.models.map((m) => m.id))]); setSelected([]); }
  });
  const save = () => execute(async () => {
    const credential = source === "managed" ? { source, secret } : source === "environment" ? { source, environment_variable: variable } : { source };
    let result: Result;
    if (custom) {
      const ids = [...new Set([...selected, ...manual.split("\n").map((s) => s.trim()).filter(Boolean)])];
      if (!ids.length) throw new Error(t("settings.connections.modelsRequired"));
      if (providers.some((p) => p.id === id)) throw new Error(t("settings.connections.duplicateId"));
      const config = { name: name.trim(), baseUrl: url, api, models: ids.map((id) => ({ id })) };
      await send("/api/model-config/preview", "POST", { providers: { [id]: config } });
      result = await send("/api/model-config/providers", "POST", { revision, id, config, credential });
    } else result = await send(`/api/model-config/providers/${encodeURIComponent(target.id)}/credential`, "PUT", { revision, credential });
    setSecret(""); onDirty(false); await onSaved(result);
  });
  return <form id={formId} className="space-y-3" onChange={() => onDirty(true)} onSubmit={(e) => { e.preventDefault(); if (!busy) void save(); }}>
    <fieldset disabled={busy} className="space-y-3">
      {custom && <><label className="block text-ui-caption text-text">{t("settings.resources.name")}<input className={field} value={name} onChange={(e) => setName(e.target.value)} required /></label><label className="block text-ui-caption text-text">{t("settings.native.providerId")}<input className={field} value={id} onChange={(e) => setId(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" maxLength={200} required /></label><label className="block text-ui-caption text-text">{t("settings.resources.baseUrl")}<input className={field} type="url" value={url} onChange={(e) => { setUrl(e.target.value); invalidate(); }} required /></label><label className="block text-ui-caption text-text">{t("settings.native.api")}<select className={field} value={api} onChange={(e) => { setApi(e.target.value); invalidate(); }}>{["openai-completions", "openai-responses", "anthropic-messages"].map((v) => <option key={v}>{v}</option>)}</select></label></>}
      <CredentialFields capabilities={capabilities} source={source} setSource={(v) => { setSource(v); setSecret(""); invalidate(); }} secret={secret} setSecret={(v) => { setSecret(v); invalidate(); }} variable={variable} setVariable={setVariable} />
      {custom && <><button type="button" className={button} disabled={!url || source === "environment"} onClick={() => void discover()}>{t("settings.native.discover")}</button><p className="text-ui-caption text-muted">{t(source === "environment" ? "settings.connections.environmentDiscovery" : "settings.native.discoveryHelp")}</p>
        <div className="space-y-2">{candidates.map((model) => <label key={model} className="flex items-start gap-2 break-all text-ui-caption text-text"><input type="checkbox" checked={selected.includes(model)} onChange={(e) => setSelected((current) => e.target.checked ? [...current, model] : current.filter((s) => s !== model))} />{model}</label>)}</div>
        <label className="block text-ui-caption text-text">{t("settings.native.manualModels")}<textarea className={field} rows={3} value={manual} onChange={(e) => setManual(e.target.value)} /></label></>}
    </fieldset>
    {error && <p role="alert" className="text-ui-caption text-error-text">{error}</p>}
  </form>;
}
