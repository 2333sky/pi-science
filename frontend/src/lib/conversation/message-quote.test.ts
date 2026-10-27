import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useRuntimeStore } from "../agent-runtime";
import { buildMessageQuote, useActiveMessageQuote, useMessageQuoteStore, type MessageQuoteSource } from "./message-quote";

const source: MessageQuoteSource = { workspaceCwd: "proj", sessionId: "s1", blockId: "u1", role: "user" };

beforeEach(() => {
  useMessageQuoteStore.setState({ quotes: {} });
  useRuntimeStore.setState({ cwd: "proj", activeSessionId: "s1" });
});

describe("buildMessageQuote", () => {
  it("produces no quote when there is no message text", () => {
    expect(buildMessageQuote({ source, messageText: "" })).toBeNull();
    expect(buildMessageQuote({ source, messageText: "   \n\t " })).toBeNull();
    expect(buildMessageQuote({ source, messageText: "  ", selection: "text" })).toBeNull();
  });

  it("quotes the whole message verbatim when nothing is selected", () => {
    expect(buildMessageQuote({ source, messageText: "Read the log" })).toEqual({
      source,
      kind: "message",
      text: "Read the log",
      messageText: "Read the log",
    });
  });

  it("treats a selection equal to the whole message as a whole-message quote", () => {
    expect(buildMessageQuote({ source, messageText: "Read the log", selection: " Read the log " })).toEqual({
      source,
      kind: "message",
      text: "Read the log",
      messageText: "Read the log",
    });
  });

  it("keeps the exact fragment and the whole message for a selection", () => {
    expect(buildMessageQuote({ source, messageText: "Read the log twice, then report.", selection: "then report." })).toEqual({
      source,
      kind: "selection",
      text: "then report.",
      messageText: "Read the log twice, then report.",
    });
  });

  it("keeps the indent of a code selection", () => {
    const messageText = "Run this:\n\n```python\ndef f():\n    return 1\n```";
    expect(buildMessageQuote({ source, messageText, selection: "    return 1" })).toEqual({
      source,
      kind: "selection",
      text: "    return 1",
      messageText,
    });
  });
});

describe("useActiveMessageQuote", () => {
  it("shows a quote only inside the conversation that filed it", () => {
    const quote = buildMessageQuote({ source, messageText: "Read the log" });
    if (!quote) throw new Error("expected a whole-message quote");
    const { result } = renderHook(() => useActiveMessageQuote());
    expect(result.current).toBeNull();

    act(() => useMessageQuoteStore.getState().setQuote(quote));
    expect(result.current).toEqual(quote);

    act(() => useRuntimeStore.setState({ activeSessionId: "s2" }));
    expect(result.current).toBeNull();

    act(() => useRuntimeStore.setState({ cwd: "other", activeSessionId: "s1" }));
    expect(result.current).toBeNull();

    act(() => useRuntimeStore.setState({ cwd: "proj", activeSessionId: "s1" }));
    expect(result.current).toEqual(quote);
  });
});
