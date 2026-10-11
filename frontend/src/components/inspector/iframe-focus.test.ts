import { afterEach, expect, it, vi } from "vitest";
import { bindPreviewFrameEscape } from "./iframe-focus";
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; document.body.replaceChildren(); });
function panelWithFrame() {
  const panel = document.createElement("div");
  const frame = document.createElement("iframe");
  panel.append(frame);
  document.body.append(panel);
  return { panel, frame };
}
it("handles Esc in an accessible iframe and removes its listener on exit", () => {
  const { panel, frame } = panelWithFrame();
  const exit = vi.fn();
  cleanup = bindPreviewFrameEscape(panel, exit);
  frame.contentDocument!.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(exit).toHaveBeenCalledOnce();
  cleanup();
  frame.contentDocument!.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(exit).toHaveBeenCalledOnce();
});
it("respects consumed Escape and dialogs belonging to the embedded page", () => {
  const { panel, frame } = panelWithFrame();
  const exit = vi.fn();
  cleanup = bindPreviewFrameEscape(panel, exit);
  const consumed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  consumed.preventDefault();
  frame.contentDocument!.body.dispatchEvent(consumed);
  const dialog = frame.contentDocument!.createElement("div");
  dialog.setAttribute("role", "dialog");
  frame.contentDocument!.body.append(dialog);
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(exit).not.toHaveBeenCalled();
});
it("binds frames added after loading and retries binding on navigation", async () => {
  const { panel, frame } = panelWithFrame();
  panel.removeChild(frame);
  const exit = vi.fn();
  cleanup = bindPreviewFrameEscape(panel, exit);
  panel.append(frame);
  await Promise.resolve();
  frame.dispatchEvent(new Event("load"));
  frame.contentDocument!.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(exit).toHaveBeenCalledOnce();
});
it("tolerates inaccessible browsing contexts", () => {
  const { panel, frame } = panelWithFrame();
  Object.defineProperty(frame, "contentDocument", { get() { throw new DOMException("Cross-origin", "SecurityError"); } });
  expect(() => { cleanup = bindPreviewFrameEscape(panel, vi.fn()); frame.dispatchEvent(new Event("load")); }).not.toThrow();
});
