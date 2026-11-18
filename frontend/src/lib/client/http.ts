type RequestOptions = RequestInit & { timeoutMs?: number | null };

export const REQUEST_TIMEOUT_MS = 45_000;
/** Runtime startup can include a cold Agent Core worker launch. */
export const RUNTIME_START_TIMEOUT_MS = 180_000;

export async function request(input: RequestInfo | URL, init?: RequestOptions): Promise<Response> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchInit } = init ?? {};
  const options = { ...fetchInit, credentials: fetchInit.credentials ?? "include" };
  if (timeoutMs === null) return fetch(input, options);

  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timeout = new Error("Request timed out while contacting the Pi-Science backend");
  const timer = globalThis.setTimeout(() => controller.abort(timeout), timeoutMs);
  try {
    return await fetch(input, { ...options, signal });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export function responseError(data: unknown, fallback?: string, preferDetail = false): string {
  const payload = typeof data === "object" && data ? (data as Record<string, unknown>) : undefined;
  if (
    payload?.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  )
    return payload.error.message;
  if (preferDetail) {
    const message = payload?.detail ?? payload?.error ?? payload?.message ?? fallback;
    return String(message || "Request failed");
  }
  for (const value of [payload?.error, payload?.detail, payload?.message]) {
    if (typeof value === "string" && value) return value;
  }
  return fallback ?? "Request failed";
}
