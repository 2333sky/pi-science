import { useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentMention } from "../../lib/conversation";
import type { ComposerEntity } from "../../lib/conversation/composer-document";
import { queryClient } from "../../lib/client/query-client";
import i18n from "../../i18n";
import { MentionComposer } from "./MentionComposer";

let fileFixture: Map<string, Array<{ name: string; path: string; isDir: boolean; size: number }>> | null = null;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("/api/files?") && fileFixture) {
    const subdir = new URL(url, "http://localhost").searchParams.get("subdir") ?? "";
    return new Response(JSON.stringify(fileFixture.get(subdir) ?? []), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.startsWith("/api/files/breadcrumbs?") && fileFixture) {
    const subdir = new URL(url, "http://localhost").searchParams.get("subdir") ?? "";
    const breadcrumbs = subdir ? subdir.split("/").map((name, index, parts) => ({ name, path: parts.slice(0, index + 1).join("/") })) : [];
    return new Response(JSON.stringify(breadcrumbs), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({
    agents: [
      { name: "reviewer", description: "Review work", source: "builtin" },
      { name: "scout", description: "Gather context", source: "builtin" },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
});

function Harness() {
  const [value, setValue] = useState("");
  const [mentions, setMentions] = useState<SubagentMention[]>([]);
  const [entities, setEntities] = useState<ComposerEntity[]>([]);
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  return (
    <MentionComposer
      cwd="project"
      value={value}
      mentions={mentions}
      entities={entities}
      onChange={(next, nextMentions, nextEntities) => { setValue(next); setMentions(nextMentions); setEntities(nextEntities); }}
      onKeyDown={() => undefined}
      onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
      onCompositionEnd={() => { setTimeout(() => { composingRef.current = false; setComposing(false); }, 0); }}
      inputRef={inputRef}
      composing={composing}
      composingRef={composingRef}
      placeholder="Prompt"
    />
  );
}

function input(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("Prompt");
}

async function typeAt(value: string, position = value.length) {
  const element = input();
  const previous = element.value;
  let start = 0;
  let oldEnd = previous.length;
  let newEnd = value.length;
  if (value.startsWith(previous)) {
    start = oldEnd = previous.length;
    newEnd = value.length;
  } else if (previous.startsWith(value)) {
    start = 0;
    oldEnd = previous.length;
    newEnd = value.length;
  } else {
    while (start < previous.length && start < value.length && previous[start] === value[start]) start += 1;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === value[newEnd - 1]) {
      oldEnd -= 1;
      newEnd -= 1;
    }
  }
  element.setSelectionRange(start, oldEnd);
  const inputType = value.length < previous.length && newEnd === start ? "deleteContentBackward" : "insertText";
  fireEvent(element, new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true }));
  fireEvent.change(element, { target: { value } });
  input().setSelectionRange(position, position);
  fireEvent.select(input());
  await Promise.resolve();
}

function renderComposer() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("MentionComposer", () => {
  // The listbox carries a translated accessible name, so this file initialises i18n itself
  // instead of relying on a side effect of an unrelated import.
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    queryClient.clear();
    fileFixture = null;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    queryClient.clear();
    fileFixture = null;
    vi.unstubAllGlobals();
  });

  it("shares discovery loading across composers in the same workspace", async () => {
    const first = renderComposer();
    const second = renderComposer();

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/settings/subagents/discovery")).length).toBe(1));

    first.unmount();
    second.unmount();
  });

  it("dismisses the menu with Escape or an outside click and keeps @ as text", async () => {
    renderComposer();
    await typeAt("@");
    expect(await screen.findByRole("listbox", { name: "Subagents" })).toBeInTheDocument();

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).toHaveValue("@");
    expect(screen.queryByRole("listbox", { name: "Subagents" })).not.toBeInTheDocument();

    await typeAt("x @", 3);
    expect(await screen.findByRole("listbox", { name: "Subagents" })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(input()).toHaveValue("x @");
    expect(screen.queryByRole("listbox", { name: "Subagents" })).not.toBeInTheDocument();
  });

  it("browses folders without binding and binds only explicit file or directory choices", async () => {
    fileFixture = new Map([
      ["", [
        { name: "structures", path: "structures", isDir: true, size: 0 },
        { name: "readme.txt", path: "readme.txt", isDir: false, size: 12 },
      ]],
      ["structures", [
        { name: "nested", path: "structures/nested", isDir: true, size: 0 },
        { name: "WT.pdb", path: "structures/WT.pdb", isDir: false, size: 100 },
      ]],
    ]);
    const { container } = renderComposer();
    await typeAt("@");
    const openFolder = await screen.findByRole("option", { name: /structures.*Open folder/ });
    fireEvent.click(openFolder);

    expect(input()).toHaveValue("@");
    const mirror = container.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(mirror?.querySelector("span")).toBeNull();
    await screen.findByRole("button", { name: "structures" });

    fireEvent.click(screen.getByRole("option", { name: /WT\.pdb/ }));
    await waitFor(() => expect(input()).toHaveValue("@structures/WT.pdb "));
    await waitFor(() => expect(mirror?.querySelector("span")?.textContent).toBe("@structures/WT.pdb"));

    await typeAt("@");
    fireEvent.click(await screen.findByRole("option", { name: /Reference entire folder/ }));
    await waitFor(() => expect(input()).toHaveValue("@structures "));
    expect(mirror?.querySelector("span")?.textContent).toBe("@structures");
  });

  it("undoes and redoes a file reference together with its identity", async () => {
    fileFixture = new Map([["data", [
      { name: "protein.csv", path: "data/protein.csv", isDir: false, size: 12 },
    ]]]);
    const { container } = renderComposer();
    await typeAt("@data/pro");
    fireEvent.click(await screen.findByRole("option", { name: /protein\.csv/ }));
    await waitFor(() => expect(input()).toHaveValue("@data/protein.csv "));
    const mirror = container.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(mirror?.querySelector("span")?.textContent).toBe("@data/protein.csv");

    fireEvent(input(), new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true }));
    await waitFor(() => expect(input()).toHaveValue("@data/pro"));
    expect(mirror?.querySelector("span")).toBeNull();

    fireEvent(input(), new InputEvent("beforeinput", { inputType: "historyRedo", bubbles: true, cancelable: true }));
    await waitFor(() => expect(input()).toHaveValue("@data/protein.csv "));
    expect(mirror?.querySelector("span")?.textContent).toBe("@data/protein.csv");
  });

  it("inserts multiple highlighted mentions and deletes a mention atomically", async () => {
    const { container } = renderComposer();
    await typeAt("@rev");
    fireEvent.click(await screen.findByRole("option", { name: /@reviewer/ }));
    await waitFor(() => expect(input()).toHaveValue("@reviewer "));
    expect(container.querySelector("span")?.textContent).toBe("@reviewer");

    await typeAt("@reviewer @sco");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(input()).toHaveValue("@reviewer @scout "));
    expect([...container.querySelectorAll("span")].map((node) => node.textContent)).toEqual(expect.arrayContaining(["@reviewer", "@scout"]));

    input().setSelectionRange("@reviewer".length, "@reviewer".length);
    fireEvent(input(), new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
    fireEvent.change(input(), { target: { value: "@reviewe @scout " } });
    await waitFor(() => expect(input()).toHaveValue(" @scout "));
    expect(container.textContent).not.toContain("@reviewer");
  });

  it("undoes and redoes a mention together with its bound identity", async () => {
    const { container } = renderComposer();
    await typeAt("@rev");
    fireEvent.click(await screen.findByRole("option", { name: /@reviewer/ }));
    await waitFor(() => expect(input()).toHaveValue("@reviewer "));
    const mirror = container.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(mirror?.querySelector("span")?.textContent).toBe("@reviewer");

    fireEvent(input(), new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true }));
    await waitFor(() => expect(input()).toHaveValue("@rev"));
    expect(mirror?.querySelector("span")).toBeNull();

    fireEvent(input(), new InputEvent("beforeinput", { inputType: "historyRedo", bubbles: true, cancelable: true }));
    await waitFor(() => expect(input()).toHaveValue("@reviewer "));
    expect(mirror?.querySelector("span")?.textContent).toBe("@reviewer");
  });

  it("scrolls the active subagent into view while navigating", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    renderComposer();
    await typeAt("@");
    await screen.findByRole("listbox", { name: "Subagents" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });

    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });

  it("wires the textarea to the listbox as a combobox (aria-controls/activedescendant)", async () => {
    renderComposer();
    await typeAt("@");
    const listbox = await screen.findByRole("listbox", { name: "Subagents" });

    expect(input()).toHaveAttribute("role", "combobox");
    expect(input()).toHaveAttribute("aria-label", "Message");
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(input().getAttribute("aria-controls")).toBe(listbox.id);
    // Active descendant points at the first option (activeIndex resets to 0).
    const activeId = input().getAttribute("aria-activedescendant");
    expect(activeId).toBe(`${listbox.id}-option-0`);
    expect(listbox.querySelector<HTMLElement>(`#${activeId}`)).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toBe(`${listbox.id}-option-1`);
  });

  it("grows with its content, scrolls at the maximum height, and shrinks again", async () => {
    renderComposer();
    const composer = input();

    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 120 });
    await typeAt("one\ntwo\nthree");
    expect(composer.style.height).toBe("120px");
    expect(composer.style.overflowY).toBe("hidden");

    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 240 });
    await typeAt("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");
    expect(composer.style.height).toBe("160px");
    expect(composer.style.overflowY).toBe("auto");

    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 20 });
    await typeAt("");
    expect(composer.style.height).toBe("64px");
    expect(composer.style.overflowY).toBe("hidden");
  });

  it("keeps the latest line visible when appending beyond the maximum height", async () => {
    const { container } = renderComposer();
    const composer = input();
    const mirror = container.querySelector<HTMLElement>("[aria-hidden='true']");
    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 240 });

    await typeAt("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");

    expect(composer.scrollTop).toBe(240);
    expect(mirror?.scrollTop).toBe(240);
  });

  it("preserves the scroll position when editing earlier overflowing text", async () => {
    renderComposer();
    const composer = input();
    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 240 });
    await typeAt("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");

    composer.scrollTop = 36;
    composer.setSelectionRange(3, 3);
    fireEvent.change(composer, { target: { value: "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight", selectionStart: 3, selectionEnd: 3 } });

    expect(composer.scrollTop).toBe(36);
  });

  it("clips mirrored text and the textarea scrollbar inside the composer corners", () => {
    const { container } = renderComposer();
    const clippingFrame = input().parentElement;
    const mirror = container.querySelector("[aria-hidden='true']");

    expect(clippingFrame).toHaveClass("overflow-hidden", "rounded-t-composer");
    expect(mirror).toHaveClass("[clip-path:inset(8px_12px)]");
  });
});

