/** Keyboard events stay inside browsing contexts. Subscribe to accessible
 * preview frames without injecting scripts or changing their sandbox policy.
 * Native PDF / cross-origin frames may be inaccessible: their parent toolbar
 * must always provide an exit action and explain the keyboard limitation. */
export function bindPreviewFrameEscape(panel: HTMLElement, exitFocus: () => void) {
  const bindings = new Map<HTMLIFrameElement, { window: Window; listener: (event: KeyboardEvent) => void }>();
  const detach = (frame: HTMLIFrameElement) => {
    const binding = bindings.get(frame);
    try { binding?.window.removeEventListener("keydown", binding.listener); } catch { /* Frame navigated to another origin. */ }
    bindings.delete(frame);
  };
  const attach = (frame: HTMLIFrameElement) => {
    detach(frame);
    try {
      const frameWindow = frame.contentDocument?.defaultView;
      if (!frameWindow) return;
      const listener = (event: KeyboardEvent) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        const target = event.target as Element | null;
        if (target?.closest?.('[role="dialog"], [aria-modal="true"]')) return;
        event.preventDefault();
        event.stopPropagation();
        exitFocus();
      };
      frameWindow.addEventListener("keydown", listener);
      bindings.set(frame, { window: frameWindow, listener });
    } catch {
      // Cross-origin frames and browser-owned PDF viewers cannot be inspected.
    }
  };
  const sync = () => {
    const frames = new Set(panel.querySelectorAll("iframe"));
    for (const frame of bindings.keys()) if (!frames.has(frame)) detach(frame);
    for (const frame of frames) if (!bindings.has(frame)) attach(frame);
  };
  const onLoad = (event: Event) => {
    if (event.target instanceof HTMLIFrameElement) attach(event.target);
  };
  panel.addEventListener("load", onLoad, true);
  const observer = new MutationObserver(sync);
  observer.observe(panel, { childList: true, subtree: true });
  sync();
  return () => {
    observer.disconnect();
    panel.removeEventListener("load", onLoad, true);
    for (const frame of bindings.keys()) detach(frame);
  };
}
