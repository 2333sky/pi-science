import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import hljs from "highlight.js/lib/common";
import { CodeViewer } from "./CodeViewer";
import { MAX_HIGHLIGHT_CHARS } from "@/lib/artifacts/highlight-policy";
import i18n, { i18nReady } from "../../i18n";

await i18nReady;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function codeText(container: HTMLElement): string | null | undefined {
  return container.querySelector("code")?.textContent;
}

describe("CodeViewer highlighting policy", () => {
  it("never auto-detects a declared language that the common bundle does not have", () => {
    const auto = vi.spyOn(hljs, "highlightAuto");
    const highlight = vi.spyOn(hljs, "highlight");
    const { container } = render(<CodeViewer code={"<tag> & raw"} language="julia" />);

    expect(auto).not.toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
    expect(codeText(container)).toBe("<tag> & raw");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders plaintext without calling into highlight.js", () => {
    const auto = vi.spyOn(hljs, "highlightAuto");
    const highlight = vi.spyOn(hljs, "highlight");
    const { container } = render(<CodeViewer code={"ATOM      1  N   ALA A   1"} language="plaintext" />);

    expect(auto).not.toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
    expect(codeText(container)).toBe("ATOM      1  N   ALA A   1");
  });

  it("uses the declared grammar when it exists", () => {
    const highlight = vi.spyOn(hljs, "highlight");
    render(<CodeViewer code={'{"a":1}'} language="json" />);

    expect(highlight).toHaveBeenCalledWith('{"a":1}', { language: "json" });
  });

  it("still auto-detects small text files with no declared language", () => {
    const auto = vi.spyOn(hljs, "highlightAuto");
    render(<CodeViewer code={"plain text"} />);

    expect(auto).toHaveBeenCalledTimes(1);
  });

  it("skips highlighting above the size guard and says so", () => {
    const highlight = vi.spyOn(hljs, "highlight");
    const code = "a".repeat(MAX_HIGHLIGHT_CHARS + 1);
    const { container } = render(<CodeViewer code={code} language="python" />);

    expect(highlight).not.toHaveBeenCalled();
    expect(codeText(container)).toBe(code);
    expect(screen.getByRole("status")).toHaveTextContent(i18n.t("filePreview.highlightSkipped"));
  });
});
