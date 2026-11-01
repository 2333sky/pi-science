import { afterEach, describe, expect, it, vi } from "vitest";

import { getClient } from "../client/pi-science-client";
import { useRuntimeStore } from "./index";
import * as settledHistory from "./recovery/settled-history";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";

installRuntimeTestEnvironment();
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const answeredPage = {
  messages: [{ id: "assistant-1", role: "assistant" as const, content: [{ type: "text" as const, text: "Recovered answer from the durable transcript" }] }],
  next_cursor: null,
  has_more: false,
  snapshot_version: "snapshot-recovered",
};

/** Connect, open the stream and answer the REST reads a turn needs. */
async function startTurn() {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
  const client = getClient();
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
  return { client, source };
}

describe("lifecycle recovery after a terminal worker error", () => {
  it("re-reads the persisted conversation once, so an exhausted recovery still shows its answer", async () => {
    let persisted: typeof answeredPage.messages = [];
    vi.spyOn(getClient(), "getMessagesPage").mockImplementation(async () => ({
      messages: persisted,
      next_cursor: null,
      has_more: false,
      snapshot_version: "snapshot-live",
    }));
    const { source } = await startTurn();
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

  it("does not re-read history for a non-terminal error, whose settled event still arrives", async () => {
    vi.spyOn(getClient(), "getMessagesPage").mockResolvedValue({
      messages: [],
      next_cursor: null,
      has_more: false,
      snapshot_version: "snapshot-live",
    });
    const resync = vi.spyOn(settledHistory, "resyncCompletedHistory");
    const { source } = await startTurn();

    // A model/runtime error ends the turn as failed, but recovery is not
    // exhausted: supervision keeps the worker and operation.settled still
    // follows. Re-reading here would replace the thread before that settle
    // gets the chance to preserve the error row and the in-flight partial.
    source.emit("error", {
      type: "error",
      sessionId: "session-recovery",
      code: "model_error",
      recoverable: false,
      message: "The model call failed",
    });

    expect(useRuntimeStore.getState().turnLifecycle).toBe("failed");
    expect(resync).not.toHaveBeenCalled();
  });

  it("keeps the error row on screen when the terminal re-read replaces the thread", async () => {
    // The connect resolves the empty history first, so the assistant block in
    // the assertions below can only come from the recovery re-read.
    let persisted: typeof answeredPage.messages = [];
    vi.spyOn(getClient(), "getMessagesPage").mockImplementation(async () => ({
      messages: persisted,
      next_cursor: null,
      has_more: false,
      snapshot_version: "snapshot-live",
    }));
    const resync = vi.spyOn(settledHistory, "resyncCompletedHistory");
    const { source } = await startTurn();

    persisted = answeredPage.messages;
    source.emit("error", {
      type: "error",
      sessionId: "session-recovery",
      code: "worker_recovery_failed",
      terminal: true,
      message: "Agent worker recovery exhausted",
    });

    await vi.waitFor(() => {
      const blocks = useRuntimeStore.getState().thread.blocks;
      expect(blocks.some((block) => block.kind === "agent")).toBe(true);
    });
    // The spy must really intercept the call, otherwise the count above is
    // meaningless.
    expect(resync).toHaveBeenCalled();
    const blocks = useRuntimeStore.getState().thread.blocks;
    expect(blocks.some((block) => block.kind === "status-line"
      && block.level === "error"
      && block.text === "Agent worker recovery exhausted")).toBe(true);
    expect(useRuntimeStore.getState().turnLifecycle).toBe("failed");
  });
});
