import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../lib/client/api";
import { settingsApi } from "../../lib/settings";
import { Section } from "./Section";

type WebSettings = { search_enabled: boolean; fetch_enabled: boolean; provider: string; api_keys: Record<string, boolean> };
const providers = ["auto", "exa", "brave", "tavily", "perplexity", "jina", "deepseek"];

export function WebSearchTab() {
  const { t } = useTranslation();
  const [data, setData] = useState<WebSettings | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    apiRequest<{ web_access: WebSettings }>("/api/settings/web-access")
      .then((value) => { if (active) setData(value.web_access); })
      .catch((reason) => { if (active) setError(String(reason.message ?? reason)); });
    return () => { active = false; };
  }, []);
  async function save(removeKey = false) {
    if (!data) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = await settingsApi.saveWebAccess<{ web_access: WebSettings }>({
        search_enabled: data.search_enabled, fetch_enabled: data.fetch_enabled, provider: data.provider,
        ...(data.provider !== "auto" && (removeKey || key.trim()) ? { api_keys: { [data.provider]: removeKey ? "" : key.trim() } } : {}),
      });
      setData(result.web_access); setKey(""); setSaved(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  function change(patch: Partial<WebSettings>) { setData((previous) => previous ? { ...previous, ...patch } : previous); setSaved(false); }
  return <div className="space-y-5">
    <p className="text-sm leading-relaxed text-muted">{t("settings.webSearch.description")}</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!data && !error && <p role="status">{t("common.loading")}</p>}
    {data && <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Section title={t("settings.webSearch.tools")}>
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-4 text-sm"><span>{t("settings.webSearch.searchEnabled")}</span><input type="checkbox" checked={data.search_enabled} disabled={busy} onChange={(event) => change({ search_enabled: event.target.checked })} /></label>
          <label className="flex items-center justify-between gap-4 text-sm"><span>{t("settings.webSearch.fetchEnabled")}</span><input type="checkbox" checked={data.fetch_enabled} disabled={busy} onChange={(event) => change({ fetch_enabled: event.target.checked })} /></label>
        </div>
      </Section>
      <Section title={t("settings.webSearch.provider")}>
        <label className="block text-sm">{t("settings.webSearch.provider")}<select className="mt-2 block w-full rounded-input border border-border bg-surface p-2 text-text" value={data.provider} disabled={busy} onChange={(event) => { change({ provider: event.target.value }); setKey(""); }}>
          {providers.map((provider) => <option key={provider} value={provider}>{provider === "auto" ? t("settings.webSearch.auto") : provider === "deepseek" ? "DeepSeek" : provider === "exa" ? "Exa" : provider === "jina" ? "Jina" : provider[0]!.toUpperCase() + provider.slice(1)}</option>)}
        </select></label>
        <p className="mt-2 text-xs leading-relaxed text-muted">{t(data.provider === "deepseek" ? "settings.webSearch.deepseekHelp" : "settings.webSearch.providerHelp")}</p>
        {data.provider !== "auto" && <div className="mt-4 space-y-2">
          <label className="block text-sm">{t("settings.webSearch.apiKey")}<input type="password" autoComplete="new-password" value={key} disabled={busy} onChange={(event) => { setKey(event.target.value); setSaved(false); }} placeholder={t(data.api_keys[data.provider] ? "settings.webSearch.keyConfigured" : "settings.webSearch.keyEmpty")} className="mt-2 block w-full rounded-input border border-border bg-surface p-2 text-text" /></label>
          {data.api_keys[data.provider] && <button type="button" disabled={busy} onClick={() => void save(true)} className="text-sm text-danger disabled:opacity-50">{t("settings.webSearch.removeKey")}</button>}
        </div>}
      </Section>
      <div className="flex items-center gap-3"><button type="submit" disabled={busy} className="rounded-input bg-accent-fill px-4 py-2 text-sm text-accent-fg disabled:opacity-50">{t(busy ? "common.saving" : "common.save")}</button>{saved && <p role="status" className="text-sm text-muted">{t("settings.webSearch.saved")}</p>}</div>
    </form>}
  </div>;
}
