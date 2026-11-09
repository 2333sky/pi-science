/** Waterline guards over the real SSE → fold → presentation path: a replayed
 *  or stale stream record must not reopen a settled turn, but a genuinely new
 *  record (next sequence, new epoch) must still take effect. */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderTurn } from "./ConversationBlocks";
import { buildTurnPresentations, isLiveLifecycle } from "../../lib/conversation/turn-presentation";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { threadFromMessages } from "../../lib/agent-runtime/event-fold";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "../../lib/agent-runtime/test-helpers";
import i18n from "../../i18n";
import type { CodeRunner } from "../markdown-viewer/MarkdownViewer";
import type { HistoryMessage } from "../../lib/client/types";

const SESSION = "session-waterline";
const EPOCH = "epoch-1";
installRuntimeTestEnvironment();

const codeRunner: CodeRunner = { cwd: "/workspace", sessionId: SESSION };
const questionnaire = {
  toolCallId: "q1",
  questions: [{ question: "Pick one", header: "Choice", multiSelect: false, options: [{ label: "A", description: "" }] }],
};

function stubWorkspace(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/messages")) return jsonResponse({ messages: [], next_cursor: null, has_more: false, snapshot_version: "v1" });
    if (url.includes("/state")) return jsonResponse(state(SESSION));
    if (url.startsWith("/api/sessions?")) return jsonResponse([]);
    throw new Error(`Unexpected request: ${url}`);
  }));
}

/** Versioned records carry their stream identity in the payload, exactly like
 *  the server records the client receives. */
function emitVersioned(type: string, seq: number, payload: Record<string, unknown> = {}, epoch = EPOCH): void {
  FakeEventSource.instances[0].emit(type, {
    type,
    sessionId: SESSION,
    schemaVersion: 3,
    seq,
    eventId: `${epoch}:${seq}`,
    streamEpoch: epoch,
    ...payload,
  });
}

function view() {
  const runtime = useRuntimeStore.getState();
  return <>{buildTurnPresentations(runtime.thread.blocks, { lastTurnLifecycle: runtime.turnLifecycle }).map((turn) => renderTurn(turn, codeRunner))}</>;
}

async function connect(): Promise<void> {
  stubWorkspace();
  await useRuntimeStore.getState().connect("/workspace", SESSION);
}

describe("stream waterline side effects", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps a settled turn folded when a replayed record arrives behind the waterline", async () => {
    await connect();
    vi.useFakeTimers();
    const { rerender } = render(view());
    emitVersioned("operation.started", 1);
    emitVersioned("tool.updated", 2, { callId: "c1", tool: "read", status: "running", input: { path: "a.ts" } });
    emitVersioned("operation.settled", 3);
    rerender(view());
    expect(useRuntimeStore.getState().turnLifecycle).toBe("settled");
    expect(screen.queryByLabelText("Execution trace")).not.toBeInTheDocument();

    // The server replays the record after the cursor boundary: same event id.
    emitVersioned("tool.updated", 2, { callId: "c1", tool: "read", status: "running", input: { path: "a.ts" } });
    rerender(view());
    expect(useRuntimeStore.getState().turnLifecycle).toBe("settled");
    expect(screen.queryByLabelText("Execution trace")).not.toBeInTheDocument();
  });

  it("applies a genuinely newer record after the turn settled", async () => {
    await connect();
    vi.useFakeTimers();
    const { rerender } = render(view());
    emitVersioned("operation.started", 1);
    emitVersioned("tool.updated", 2, { callId: "c1", tool: "read", status: "running", input: { path: "a.ts" } });
    emitVersioned("operation.settled", 3);
    rerender(view());
    expect(useRuntimeStore.getState().turnLifecycle).toBe("settled");

    // Next position, never observed: this may be a new run's activity and
    // must not be treated as a replay.
    emitVersioned("tool.updated", 4, { callId: "c2", tool: "grep", status: "running", input: { pattern: "x" } });
    rerender(view());
    expect(useRuntimeStore.getState().turnLifecycle).toBe("active");
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument();
  });

  it("does not resurrect an answered questionnaire from a replayed record", async () => {
    await connect();
    vi.useFakeTimers();
    const { rerender } = render(view());
    emitVersioned("operation.started", 1);
    emitVersioned("questionnaire.asked", 2, questionnaire);
    emitVersioned("operation.settled", 3);
    rerender(view());
    expect(useRuntimeStore.getState().pendingQuestionnaire).toBeNull();

    emitVersioned("questionnaire.asked", 2, questionnaire);
    rerender(view());
    expect(useRuntimeStore.getState().pendingQuestionnaire).toBeNull();
    expect(useRuntimeStore.getState().turnLifecycle).toBe("settled");
  });

  it("ignores a replay after a second turn has settled", async () => {
    await connect();
    vi.useFakeTimers();
    const { rerender } = render(view());
    emitVersioned("operation.started", 1);
    emitVersioned("tool.updated", 2, { callId: "c1", tool: "read", status: "running", input: { path: "a.ts" } });
    emitVersioned("operation.settled", 3);
    emitVersioned("operation.started", 4);
    emitVersioned("tool.updated", 5, { callId: "c2", tool: "grep", status: "running", input: { pattern: "x" } });
    emitVersioned("operation.settled", 6);
    rerender(view());
    expect(useRuntimeStore.getState().turnLifecycle).toBe("settled");

    emitVersioned("tool.updated", 2, { callId: "c1", tool: "read", status: "running", input: { path: "a.ts" } });
    rerender(view());
    expect(useRuntimeStore.getState().turnLifecycle).toBe("settled");
  });

  it("treats a repeated duplicate of the settled record as idempotent", async () => {
    await connect();
    vi.useFakeTimers();
    const { rerender } = render(view());
    emitVersioned("operation.started", 1);
    emitVersioned("operation.settled", 2);
    emitVersioned("operation.settled", 2);
    rerender(view());
    expect(useRuntimeStore.getState().turnLifecycle).toBe("settled");
  });

  it("accepts the first record of a new stream epoch", async () => {
    await connect();
    vi.useFakeTimers();
    const { rerender } = render(view());
    emitVersioned("operation.started", 1);
    emitVersioned("operation.settled", 2);
    rerender(view());
    expect(useRuntimeStore.getState().turnLifecycle).toBe("settled");

    emitVersioned("operation.started", 1, {}, "epoch-2");
    rerender(view());
    expect(useRuntimeStore.getState().turnLifecycle).toBe("active");
    expect(useRuntimeStore.getState().thread.foldState?.recoveryEpoch).toBe("epoch-2");
  });

  it("keeps a restored queued turn collapsed with only its queued status row", async () => {
    const history: HistoryMessage[] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], timestamp: "2026-09-08T00:00:00.000Z" },
      { id: "a1", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read" }], timestamp: "2026-09-08T00:00:01.000Z" },
      { id: "r1", role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "ok" }], timestamp: "2026-09-08T00:00:02.000Z" },
    ];
    const thread = threadFromMessages(history);
    useRuntimeStore.setState({ thread, working: true, turnLifecycle: "queued" });
    render(view());
    // `queued` must not count as a live lifecycle: the restored message has
    // not started running, so the turn cannot present as active.
    expect(isLiveLifecycle("queued")).toBe(false);
    expect(buildTurnPresentations(thread.blocks, { lastTurnLifecycle: "queued" })[0]?.active).toBe(false);
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.queryByLabelText("Execution trace")).not.toBeInTheDocument();

    // The status row must not claim a running phase either.
    act(() => {});
    expect(screen.getByText("Queued").closest("[data-state]")).toHaveAttribute("data-state", "waiting");
  });
});
