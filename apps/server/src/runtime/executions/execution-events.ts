import { workspaceIdentity } from "../agent/workspace-session-identity.js";
import type { ExecutionEvent } from "@pi-science/contracts";

const listeners = new Map<string, Set<(event: ExecutionEvent) => void>>();

export function emitExecutionEvent(cwd: string, event: ExecutionEvent): void {
  for (const listener of [...(listeners.get(workspaceIdentity(cwd)) ?? [])]) {
    try {
      listener(event);
    } catch {
      /* observers must never break persistence */
    }
  }
}

export function subscribeExecutionEvents(
  cwd: string,
  listener: (event: ExecutionEvent) => void,
): () => void {
  const key = workspaceIdentity(cwd);
  const subscribers = listeners.get(key) ?? new Set<(event: ExecutionEvent) => void>();
  listeners.set(key, subscribers);
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0 && listeners.get(key) === subscribers) listeners.delete(key);
  };
}
