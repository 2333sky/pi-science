import { describe, expect, it, vi } from "vitest";
import { ConversationEventHub } from "./conversation-event-hub.js";
import type { SseEventRecord } from "./event-store.js";

describe("conversation subscription lifecycle", () => {
  it("removes a subscriber when its replay read rejects", async () => {
    const hub = new ConversationEventHub({
      append: async () => undefined,
      readAfter: async () => {
        throw new Error("store unavailable");
      },
    });
    await expect(hub.subscribe("/workspace", "session", "epoch:0", () => true)).rejects.toThrow(
      "store unavailable",
    );
    expect(hub.hasSubscribers("/workspace", "session")).toBe(false);
  });

  it("cancels a pending subscription without waiting for the store", async () => {
    const hub = new ConversationEventHub({
      append: async () => undefined,
      readAfter: () => new Promise<SseEventRecord[]>(() => {}),
    });
    const abort = new AbortController();
    const subscribing = hub.subscribe("/workspace", "session", "epoch:0", () => true, true, {
      signal: abort.signal,
    });
    expect(hub.hasSubscribers("/workspace", "session")).toBe(true);
    abort.abort();
    const unsubscribe = await subscribing;
    unsubscribe();
    expect(hub.hasSubscribers("/workspace", "session")).toBe(false);
  }, 2_000);

  it("notifies and cancels a subscriber when live events exceed its replay backlog", async () => {
    const hub = new ConversationEventHub({
      append: async () => undefined,
      readAfter: () => new Promise<SseEventRecord[]>(() => {}),
    });
    const onAbandon = vi.fn();
    const subscribing = hub.subscribe("/workspace", "session", "epoch:0", () => true, true, {
      onAbandon,
    });
    const liveEvents = vi.fn();
    const unsubscribeLive = await hub.subscribe(
      "/workspace",
      "session",
      undefined,
      liveEvents,
      false,
    );
    for (let sequence = 1; sequence <= 2_001; sequence += 1) {
      await hub.publish("/workspace", "session", { type: "status.updated", sequence });
    }
    await subscribing;
    expect(onAbandon).toHaveBeenCalledExactlyOnceWith("replay_backlog_overflow");
    expect(liveEvents).toHaveBeenCalledTimes(2_001);
    expect(hub.hasSubscribers("/workspace", "session")).toBe(true);
    unsubscribeLive();
    expect(hub.hasSubscribers("/workspace", "session")).toBe(false);
  }, 10_000);
});
