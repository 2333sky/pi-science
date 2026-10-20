import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../../../lib/client/api";

export type DiscoveredModel = { id: string; display_name?: string };

/** Discovery is a cancellable read of a draft, independent of saving the connection. */
export function useModelDiscovery(enabled: boolean, url: string, api: string, source: string, secret: string, variable: string) {
  const [attempt, setAttempt] = useState(0);
  const lastAttempt = useRef(0);
  const [state, setState] = useState<{ status: "idle" | "pending" | "loading" | "success" | "error"; models: DiscoveredModel[] }>({ status: "idle", models: [] });
  let validUrl = false;
  try { validUrl = ["http:", "https:"].includes(new URL(url).protocol); } catch { /* Incomplete draft. */ }
  const ready = enabled && validUrl && (source === "managed" ? Boolean(secret.trim()) : source === "environment" ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) : source === "keyless");
  useEffect(() => {
    const immediate = attempt !== lastAttempt.current;
    lastAttempt.current = attempt;
    if (!ready) { setState({ status: "idle", models: [] }); return; }
    const controller = new AbortController();
    let active = true;
    setState({ status: "pending", models: [] });
    const timer = setTimeout(async () => {
      setState({ status: "loading", models: [] });
      try {
        const result = await apiRequest<{ models: DiscoveredModel[] }>("/api/model-config/discover", {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base_url: url, api, ...(source === "managed" ? { secret } : source === "environment" ? { environment_variable: variable } : {}) }),
        });
        if (active) setState({ status: "success", models: [...new Map(result.models.map((model) => [model.id, model])).values()] });
      } catch {
        // Upstream failures must not echo credentials or prevent manual configuration.
        if (active) setState({ status: "error", models: [] });
      }
    }, immediate ? 0 : 800);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [ready, url, api, source, secret, variable, attempt]);
  return { ...state, ready, retry: () => setAttempt((value) => value + 1) };
}
