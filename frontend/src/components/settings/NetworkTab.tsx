import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../lib/client/api";
import { Section } from "./Section";

type Profile = "analysis" | "mcp";
type Rule = { domain: string; profile: Profile; decision: "allow" | "deny"; createdAt: string };
type NetworkSettings = { revision: number; rules: Rule[]; profiles: Record<Profile, { allowedDomains: string[]; deniedDomains: string[] }> };

export function NetworkTab() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<NetworkSettings | null>(null);
  const [profile, setProfile] = useState<Profile>("analysis");
  const [domain, setDomain] = useState("");
  const [decision, setDecision] = useState<"allow" | "deny">("allow");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    apiRequest<NetworkSettings>("/api/settings/network").then((value) => { if (active) setData(value); }).catch((reason) => { if (active) setError(String(reason.message ?? reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function mutate(method: "POST" | "DELETE", body: unknown) {
    setBusy(true); setError(null);
    try {
      await apiRequest("/api/settings/network", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setData(await apiRequest<NetworkSettings>("/api/settings/network"));
      if (method === "POST") setDomain("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <p className="text-sm leading-relaxed text-muted">{t("settings.network.description")}</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!data ? loading ? <p role="status">{t("common.loading")}</p> : null : <>
      <Section title={t("settings.network.rules")}>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void mutate("POST", { profile, domain, decision }); }}>
          <label className="text-xs text-muted">{t("settings.network.profile")}<select aria-label={t("settings.network.profile")} value={profile} onChange={(event) => setProfile(event.target.value as Profile)} disabled={busy} className="mt-1 block rounded-input border border-border bg-surface p-2 text-sm text-text">
            <option value="analysis">{t("settings.network.analysis")}</option><option value="mcp">{t("settings.network.mcp")}</option>
          </select></label>
          <label className="min-w-48 flex-1 text-xs text-muted">{t("settings.network.domain")}<input value={domain} onChange={(event) => setDomain(event.target.value)} disabled={busy} maxLength={253} required placeholder="api.example.org / 192.168.1.10:8080" className="mt-1 block w-full rounded-input border border-border bg-surface p-2 text-sm text-text" /></label>
          <label className="text-xs text-muted">{t("settings.network.decision")}<select aria-label={t("settings.network.decision")} value={decision} onChange={(event) => setDecision(event.target.value as "allow" | "deny")} disabled={busy} className="mt-1 block rounded-input border border-border bg-surface p-2 text-sm text-text">
            <option value="allow">{t("settings.network.allow")}</option><option value="deny">{t("settings.network.deny")}</option>
          </select></label>
          <button type="submit" disabled={busy || !domain.trim()} className="rounded-input bg-accent-fill px-3 py-2 text-sm text-accent-fg disabled:opacity-50">{t("settings.network.save")}</button>
        </form>
        <p className="mt-2 text-xs text-muted">{t("settings.network.scope")}</p>
        <ul className="mt-4 divide-y divide-border">
          {data.rules.map((rule) => <li key={`${rule.profile}:${rule.domain}`} className="flex items-center justify-between gap-3 py-3 text-sm">
            <div className="min-w-0"><span className="break-all font-mono">{rule.domain}</span><span className="ml-2 text-muted">{t(`settings.network.${rule.profile}`)} · {t(`settings.network.${rule.decision}`)}</span></div>
            <button type="button" disabled={busy} aria-label={`${t("settings.network.remove")} ${rule.domain}`} onClick={() => void mutate("DELETE", { profile: rule.profile, domain: rule.domain })} className="shrink-0 rounded-input border border-border px-2 py-1 disabled:opacity-50">{t("settings.network.remove")}</button>
          </li>)}
        </ul>
        {data.rules.length === 0 && <p className="mt-3 text-sm text-muted">{t("settings.network.empty")}</p>}
      </Section>
      <Section title={t("settings.network.operator")}>
        <p className="mb-3 text-xs text-muted">{t("settings.network.operatorHelp")}</p>
        {(["analysis", "mcp"] as const).map((role) => <div key={role} className="mb-3 text-sm"><h3 className="font-medium">{t(`settings.network.${role}`)}</h3><p className="mt-1 break-all text-xs text-muted">{t("settings.network.allow")}: {data.profiles[role].allowedDomains.join(", ") || "—"}</p><p className="mt-1 break-all text-xs text-muted">{t("settings.network.deny")}: {data.profiles[role].deniedDomains.join(", ") || "—"}</p></div>)}
      </Section>
    </>}
  </div>;
}
