import { beforeEach, describe, expect, it, vi } from "vitest";
import { promptContentDigest, saveLocalPromptRequest } from "../../client/prompt-request-cache";
import { installClientTestEnvironment } from "../../client/test-helpers";
import type { GetState } from "../actions/types";
import { replayPendingPrompts, resetPendingPromptReplayForTest } from "./prompt-replay";

installClientTestEnvironment();

const CWD = "/workspace-a";
const CLIENT_MESSAGE_ID = "8fd824aa-51d3-4f63-839c-09e021b7970b";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function store(overrides: Partial<{ cwd: string; activeSessionId: string | null; working: boolean }> = {}) {
  const state = { cwd: CWD, activeSessionId: null as string | null, working: false, ...overrides };
  const connect = vi.fn(async () => undefined);
  const sendPrompt = vi.fn(async (): Promise<string | null> => "session-created");
  const get = (() => ({ ...state, connect, sendPrompt })) as unknown as GetState;
  return { get, connect, sendPrompt, state };
}

function seed(text = "draw the curve", overrides: Partial<{ sessionId: string; createdAt: number }> = {}) {
  saveLocalPromptRequest({
    cwd: CWD,
    sessionId: overrides.sessionId ?? "",
    clientMessageId: CLIENT_MESSAGE_ID,
    contentDigest: promptContentDigest(text),
    text,
    createdAt: overrides.createdAt ?? Date.now(),
    status: "pending",
  });
}

beforeEach(() => {
  resetPendingPromptReplayForTest();
});

describe("replayPendingPrompts", () => {
  it("replays a stranded prompt once with its recorded id, even when StrictMode mounts twice", async () => {
    seed();
    const { get, sendPrompt } = store();
    const gate = deferred<void>();
    sendPrompt.mockImplementation(async () => { await gate.promise; return "session-created"; });

    const first = replayPendingPrompts(CWD, get);
    const second = replayPendingPrompts(CWD, get);
    await Promise.resolve();
    gate.resolve();

    // The create round trip is the same one for both callers: the second call
    // must not spend another idempotency key on the same prompt.
    expect(await second).toBeNull();
    expect(await first).toBe("session-created");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith("draw the curve", CLIENT_MESSAGE_ID);
  });

  it("does nothing when no unfinished prompt exists", async () => {
    const { get, sendPrompt } = store();
    expect(await replayPendingPrompts(CWD, get)).toBeNull();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("adopts the session the interrupted create already made instead of creating another", async () => {
    seed("adopt me", { sessionId: "session-existing" });
    const { get, connect, sendPrompt } = store();

    expect(await replayPendingPrompts(CWD, get)).toBe("session-created");
    expect(connect).toHaveBeenCalledWith(CWD, "session-existing");
    expect(sendPrompt).toHaveBeenCalledWith("adopt me", CLIENT_MESSAGE_ID);
  });

  it("keeps the record when the replay fails so a later landing retries it", async () => {
    seed();
    const { get, sendPrompt } = store();
    sendPrompt.mockRejectedValueOnce(new Error("offline"));

    expect(await replayPendingPrompts(CWD, get)).toBeNull();
    expect(await replayPendingPrompts(CWD, get)).toBe("session-created");
    expect(sendPrompt).toHaveBeenCalledTimes(2);
  });

  it("never replays a prompt older than six hours", async () => {
    seed("stale", { createdAt: Date.now() - 6 * 60 * 60 * 1000 - 1 });
    const { get, sendPrompt } = store();
    expect(await replayPendingPrompts(CWD, get)).toBeNull();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("stays off a workspace that is not the active one", async () => {
    seed();
    const { get, sendPrompt } = store({ cwd: "/workspace-b" });
    expect(await replayPendingPrompts(CWD, get)).toBeNull();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("does not open a conversation into an active session", async () => {
    seed();
    const { get, sendPrompt } = store({ activeSessionId: "session-a" });
    expect(await replayPendingPrompts(CWD, get)).toBeNull();
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
