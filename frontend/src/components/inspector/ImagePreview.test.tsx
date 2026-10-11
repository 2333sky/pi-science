import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ImagePreview } from "./ImagePreview";
let resize: () => void;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("fits image dimensions, changes magnification independently, and restores fit after resize", () => {
  render(<ImagePreview url="/sample.png" filename="sample.png" />);
  const img = screen.getByRole("img") as HTMLImageElement;
  const viewport = img.parentElement!.parentElement!;
  Object.defineProperties(viewport, { clientWidth: { value: 432 }, clientHeight: { value: 232 } });
  act(() => resize());
  Object.defineProperties(img, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
  fireEvent.load(img);
  expect(img).toHaveStyle({ width: "400px", height: "200px" });
  fireEvent.click(screen.getByRole("button", { name: "Original size" }));
  expect(img).toHaveStyle({ width: "800px", height: "400px" });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(img).toHaveStyle({ width: "960px", height: "480px" });
  act(() => resize());
  expect(img).toHaveStyle({ width: "960px" });
  fireEvent.click(screen.getByRole("button", { name: "Fit to window" }));
  expect(img).toHaveStyle({ width: "400px" });
  expect(screen.getByText("800 × 400 px")).toBeInTheDocument();
});
