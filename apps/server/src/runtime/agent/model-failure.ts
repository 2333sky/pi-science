/** A provider failure that pi-agent-core persisted as a `stopReason: "error"` assistant message.
 * The runtime never throws it: the durable record is the only place the reason survives, so both
 * history projection and the server log read it from there. */
export type ModelFailureCategory = "credential_missing" | "upstream_error" | "model_error";
export type ModelFailureLog = (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;

export interface ModelFailure {
  category: ModelFailureCategory;
  provider: string;
  model: string;
  reason: string;
}

const CREDENTIAL = /not configured|no api key|api key.*(?:invalid|missing|not set)|invalid.*api key|unauthenticated|unauthori[sz]ed|authentication|\b401\b/i;
const UPSTREAM = /rate.?limit|too many requests|\b429\b|\b5\d\d\b|service unavailable|overloaded|upstream|timed out|timeout|econn|fetch failed|network/i;

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

/** Reads provider, model and category out of a message that failed before producing any content. */
export function modelFailureFrom(message: unknown): ModelFailure | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return null;
  const failed = record.stopReason === "error" || text(record.errorMessage) !== "";
  if (!failed) return null;
  const reason = text(record.errorMessage) || "The model request failed";
  return {
    category: CREDENTIAL.test(reason) ? "credential_missing" : UPSTREAM.test(reason) ? "upstream_error" : "model_error",
    provider: text(record.provider) || "unknown",
    model: text(record.model) || "unknown",
    reason,
  };
}

/** One line a user or an operator can act on, without leaking credentials. */
export function modelFailureText(failure: ModelFailure): string {
  return `Model request failed (${failure.provider}/${failure.model}, ${failure.category}): ${failure.reason}`;
}

/** Logs the failure once per completed message; unrelated events stay silent. */
export function reportModelFailure(log: ModelFailureLog, event: unknown): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const record = event as Record<string, unknown>;
  if (record.type !== "message.completed") return;
  const failure = modelFailureFrom(record.message);
  if (!failure) return;
  log("error", modelFailureText(failure), { provider: failure.provider, model: failure.model, category: failure.category });
}
