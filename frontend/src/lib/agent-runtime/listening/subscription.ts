/** Own the single subscription binding and preserve stream effect ordering. */
import type { PiScienceClient } from "../../client/pi-science-client";
import { runtimeStore } from "../store-access";
import { listenerBinding } from "./binding";
import { disarmTurnWatchdog, noteTurnEvent } from "./watchdog";
import { resetOptimisticRetry, handleMissingSessionEvent } from "./missing-session";
import { resetRunsSignal, signalRunsForCurrentWorkspace, isExecutionBoundary, isRecoveryAttach } from "./runs-signal";
import { handleTransportEvent } from "./transport";
import { applyInteractionEvent } from "./interactions";
import { applyLifecycleEvent } from "./lifecycle";
import { applyEventProjection } from "./projection";
import { isBehindStreamWaterline } from "../folding/versioned-event";

/** One subscription dispatches effects in the same order as the stream. */
export function registerEventListener(client: PiScienceClient): void {
  if (listenerBinding.client === client && listenerBinding.unsubscribe) return;
  disarmTurnWatchdog();
  resetOptimisticRetry();
  resetRunsSignal();
  listenerBinding.unsubscribe?.();
  listenerBinding.client = client;
  listenerBinding.unsubscribe = client.onEvent((event) => {
    const state = runtimeStore.getState();
    if (event.sessionId && state.activeSessionId && event.sessionId !== state.activeSessionId) return;
    if (event.type === "approval.mode.changed") {
      window.dispatchEvent(new CustomEvent("pi-science-approval-mode-changed", { detail: { ...event, cwd: state.cwd } }));
      // The record still carries a stream position: skipping it here would
      // leave the fold waterline one short and turn the next record into a
      // sequence hole (and a full rebase). The fold is a no-op for this type.
      return applyEventProjection(event);
    }
    // Transport chatter must not reset the watchdog's silence clock.
    if (!event.type.startsWith("connection.")) noteTurnEvent();
    if (isExecutionBoundary(event) || isRecoveryAttach(event) || event.type === "stream.gap") signalRunsForCurrentWorkspace();

    const transport = handleTransportEvent(client, event, state);
    if (transport) return transport === "deferred" ? false : undefined;
    if (handleMissingSessionEvent(client, event, state)) return;
    // The fold discards replayed events at/below its waterline, but firing the
    // side effects first would let a late activity event reopen a settled turn
    // (or resurrect an answered questionnaire). Skip to the projection so the
    // fold still accounts for the record and advances its cursor.
    if (isBehindStreamWaterline(state.thread, event)) return applyEventProjection(event);
    applyInteractionEvent(event);
    // Lifecycle guards deliberately use the snapshot captured before effects.
    applyLifecycleEvent(event, state);
    return applyEventProjection(event);
  });
}
