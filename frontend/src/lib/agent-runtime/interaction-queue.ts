import type { PendingInteraction, RuntimeState } from "./types";

type InteractionState = Pick<RuntimeState, "pendingInteraction" | "pendingInteractionQueue">;

/** Preserve every parallel request, keeping the visible card stable. */
export function enqueueInteraction(state: InteractionState, interaction: PendingInteraction): InteractionState {
  if (state.pendingInteraction?.requestId === interaction.requestId) {
    return { pendingInteraction: interaction, pendingInteractionQueue: state.pendingInteractionQueue };
  }
  const queue = state.pendingInteractionQueue;
  const existing = queue.findIndex((item) => item.requestId === interaction.requestId);
  return {
    pendingInteraction: state.pendingInteraction ?? interaction,
    pendingInteractionQueue: !state.pendingInteraction ? queue
      : existing < 0 ? [...queue, interaction]
      : queue.map((item, index) => index === existing ? interaction : item),
  };
}

/** Used by both SSE resolution and POST completion; safe in either order. */
export function resolveInteraction(state: InteractionState, requestId: string): InteractionState {
  const queue = state.pendingInteractionQueue.filter((item) => item.requestId !== requestId);
  if (state.pendingInteraction?.requestId !== requestId) {
    return { pendingInteraction: state.pendingInteraction, pendingInteractionQueue: queue };
  }
  return { pendingInteraction: queue[0] ?? null, pendingInteractionQueue: queue.slice(1) };
}
