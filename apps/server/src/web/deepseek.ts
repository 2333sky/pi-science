import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateOutboundHttpUrl } from "../security/outbound-security.js";

export type WebResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details: Record<string, unknown>; isError?: boolean };
type SearchParams = { query: string; numResults?: number; recencyFilter?: "day" | "week" | "month" | "year"; domainFilter?: string[] };
const searchResponse = z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string(), summary: z.string(), date: z.string().nullable().optional() })) });
const fetchResponse = z.object({ title: z.string(), content: z.string() });
const MAX_BYTES = 5 * 1024 * 1024;
const INLINE_CHARS = 12_000;

/** Fixed official endpoint; never follow redirects with the provider key. */
async function request(endpoint: "search" | "fetch", body: unknown, key: string | undefined, signal?: AbortSignal): Promise<unknown> {
  if (!key) throw new Error("Configure a DeepSeek API key in Settings → Web search");
  const response = await fetch(`https://api.deepseek.com/v1/tools/${endpoint}`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("DeepSeek response exceeds size limit");
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("DeepSeek response exceeds size limit");
      chunks.push(value);
    }
  } finally { await reader?.cancel().catch(() => undefined); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error(`DeepSeek returned an invalid JSON response (HTTP ${response.status})`); }
  if (!response.ok) {
    const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(data);
    const message = error.success ? error.data.error.message.replaceAll(key, "[redacted]").slice(0, 500) : "Request failed";
    throw new Error(`DeepSeek HTTP ${response.status}: ${message}`);
  }
  return data;
}

export function deepSeekQuery(params: SearchParams, now = new Date()): string {
  const include: string[] = [], exclude: string[] = [];
  for (const raw of params.domainFilter ?? []) {
    const negative = raw.startsWith("-");
    const domain = negative ? raw.slice(1) : raw;
    if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain)) throw new Error("DeepSeek domainFilter must contain hostnames, optionally prefixed with '-'");
    (negative ? exclude : include).push(`${negative ? "-site:" : "site:"}${domain}`);
  }
  const parts = [params.query];
  if (include.length) parts.push(include.join(" OR "));
  parts.push(...exclude);
  if (params.recencyFilter) {
    const after = new Date(now);
    after.setUTCDate(after.getUTCDate() - { day: 1, week: 7, month: 30, year: 365 }[params.recencyFilter]);
    parts.push(`after:${after.toISOString().slice(0, 10)}`);
  }
  const query = parts.join(" ").trim();
  if ([...query].length < 1 || [...query].length > 128) throw new Error("DeepSeek search queries must contain 1–128 Unicode characters, including site/date filters. Shorten the query or remove filters.");
  return query;
}

/** Worker-local bounded cache also serves old DeepSeek results after a provider switch. */
export class DeepSeekWeb {
  private readonly cache = new Map<string, { text: string; kind: "search" | "fetch" }>();
  private store(text: string, kind: "search" | "fetch"): WebResult {
    const responseId = `deepseek_${randomUUID()}`;
    this.cache.set(responseId, { text, kind });
    while (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!);
    return this.page(responseId, 0, INLINE_CHARS);
  }
  page(responseId: string, offset = 0, limit = INLINE_CHARS): WebResult {
    const value = this.cache.get(responseId);
    if (!value) throw new Error("DeepSeek cached result expired; repeat the search or fetch");
    const end = Math.min(value.text.length, offset + limit);
    const guidance = end < value.text.length ? `\n\nUse web_fetch({ responseId: "${responseId}", offset: ${end}, limit: ${limit} }) for the next slice.` : "";
    return { content: [{ type: "text", text: value.text.slice(offset, end) + guidance + `\n\nResponse ID: ${responseId}` }],
      details: { provider: "deepseek", responseId, ...(value.kind === "search" ? { searchId: responseId } : {}), offset, totalChars: value.text.length } };
  }
  async search(params: SearchParams, key?: string, signal?: AbortSignal): Promise<WebResult> {
    const query = deepSeekQuery(params);
    const parsed = searchResponse.safeParse(await request("search", { query, count: params.numResults ?? 10, need_content: false }, key, signal));
    if (!parsed.success) throw new Error("DeepSeek returned an invalid search result");
    const text = parsed.data.results.length ? parsed.data.results.map((result, index) =>
      `${index + 1}. ${result.title}\n${result.url}\n${result.summary || result.snippet}${result.date ? `\nPublished: ${result.date}` : ""}`).join("\n\n") : "No matching results.";
    return this.store(text, "search");
  }
  async fetch(url: string, key?: string, signal?: AbortSignal): Promise<WebResult> {
    if (!key) throw new Error("Configure a DeepSeek API key in Settings → Web search");
    // Keep local/private targets out of the public-web tool even though the
    // actual page download happens at DeepSeek rather than in this worker.
    await validateOutboundHttpUrl(url, { allowPrivate: false });
    signal?.throwIfAborted();
    const parsed = fetchResponse.safeParse(await request("fetch", { url }, key, signal));
    if (!parsed.success) throw new Error("DeepSeek returned an invalid fetched page");
    return this.store(`${parsed.data.title ? `# ${parsed.data.title}\n\n` : ""}${parsed.data.content}`, "fetch");
  }
}
