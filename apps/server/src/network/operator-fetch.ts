import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";

// Reuse connections while honoring HTTP(S)_PROXY / NO_PROXY without requiring
// NODE_USE_ENV_PROXY at process startup. TLS verification keeps its defaults.
let dispatcher: EnvHttpProxyAgent | undefined;
export async function operatorFetch(url: string, init?: RequestInit): Promise<Response> {
  dispatcher ??= new EnvHttpProxyAgent();
  return await proxyFetch(url, { ...init, dispatcher } as Parameters<typeof proxyFetch>[1]) as unknown as Response;
}
