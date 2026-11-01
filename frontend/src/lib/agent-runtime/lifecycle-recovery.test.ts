import { afterEach, describe, expect, it, vi } from "vitest";

import { getClient } from "../client/pi-science-client";
import { useRuntimeStore } from "./index";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";

installRuntimeTestEnvironment();
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const answeredPage = {
  messages: [{ id: "assistant-1", role: "assistant" as const, content: [{ type: "text" as const, text: "Recovered answer from the durable transcript" }] }],
  next_cursor: null,
  has_more: false,
  snapshot_version: "snapshot-recovered",
};

describe("lifecycle recovery after a terminal worker error", () => {
  it("re-reads the persisted conversation once, so an exhausted recovery still shows its answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const client = getClient();
    let persisted: typeof answeredPage.messages = [];
    vi.spyOn(client, "getMessagesPage").mockImplementation(async () => ({
      messages: persisted,
      next_cursor: null,
      has_more: false,
      snapshot_version: "snapshot-live",
    }));
    vi.spyOn(client, "getSessionState").mockResolvedValue(state("session-recovery"));
    vi.spyOn(client, "getTurnArtifacts").mockResolvedValue({ turns: [] });

    await useRuntimeStore.getState().connect("/workspace", "session-recovery");
    const source = FakeEventSource.instances[0];
    source.open();
    source.emit("operation.started", {
      type: "operation.started",
      sessionId: "session-recovery",
      turnId: "turn-1",
      runId: "run-1",
    });
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, turnLifecycle: "active" });

    // The worker died before it could persist and publish operation.settled:
    // supervision publishes this terminal error in its place, with no turnId.
    persisted = answeredPage.messages;
    source.emit("error", {
      type: "error",
      sessionId: "session-recovery",
      code: "worker_recovery_failed",
      terminal: true,
      message: "Agent worker recovery exhausted",
    });

    expect(useRuntimeStore.getState().turnLifecycle).toBe("failed");
    expect(useRuntimeStore.getState().working).toBe(false);

    // The answer is durable even though no settled event will ever arrive.
    await vi.waitFor(() => {
      const blocks = useRuntimeStore.getState().thread.blocks;
      expect(blocks.some((block) => block.kind === "agent")).toBe(true);
    });
    const assistantText = useRuntimeStore.getState().thread.blocks
      .flatMap((block) => (block.kind === "agent" ? block.parts.map((part) => part.text) : []))
      .join("");
    expect(assistantText).toContain("Recovered answer from the durable transcript");
    // A recovery failure is still a failure: the added re-read must not
    // promote the turn to settled.
    expect(useRuntimeStore.getState().turnLifecycle).toBe("failed");
  });
});
