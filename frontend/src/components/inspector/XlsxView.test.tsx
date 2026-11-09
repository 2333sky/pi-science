import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SheetHtml } from "../../lib/shared/xlsx";
import i18n, { i18nReady } from "../../i18n";

const { workbookSheets } = vi.hoisted(() => ({ workbookSheets: vi.fn() }));

vi.mock("@/lib/shared/xlsx", () => ({ workbookSheets }));

import { XlsxView } from "./OfficePreview";

await i18nReady;

function sheet(name: string, rows: number, truncated: boolean, html?: string): SheetHtml {
  return {
    name,
    rows,
    truncated,
    html: html ?? `<table><tbody><tr><td>${name}</td></tr></tbody></table>`,
  };
}

/** The workbook HTML is written into a shadow root, so query it through the host. */
function shadowPage(container: HTMLElement): string {
  const host = [...container.querySelectorAll("div")].find((node) => node.shadowRoot);
  return host?.shadowRoot?.querySelector(".page")?.innerHTML ?? "";
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  workbookSheets.mockReset();
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("XlsxView", () => {
  it("shows the rendered row count in the truncation notice instead of a bare placeholder", async () => {
    workbookSheets.mockResolvedValue([sheet("Data", 600, true)]);
    render(<XlsxView bytes={new ArrayBuffer(4)} scrollKey="truncation" />);

    const notice = await screen.findByText(/Showing first 600 rows/);
    expect(notice.textContent).not.toContain("{{count}}");

    await act(() => i18n.changeLanguage("zh-Hans"));
    const chinese = await screen.findByText(/显示前 600 行/);
    expect(chinese.textContent).not.toContain("{{count}}");
    expect(document.body.textContent).not.toContain("{{count}}");
  });

  it("keeps the selected sheet when a language change re-parses the workbook", async () => {
    workbookSheets.mockImplementation(async (_bytes: ArrayBuffer, locale?: string) => [
      sheet("First", 1, false, `<table><tbody><tr><td>first-${locale}</td></tr></tbody></table>`),
      sheet("Second", 1, false, `<table><tbody><tr><td>second-${locale}</td></tr></tbody></table>`),
    ]);
    const { container } = render(<XlsxView bytes={new ArrayBuffer(4)} scrollKey="tabs" />);

    fireEvent.click(await screen.findByRole("button", { name: "Second" }));
    await waitFor(() => expect(shadowPage(container)).toContain("second-en"));

    await act(() => i18n.changeLanguage("zh-Hans"));
    await waitFor(() => expect(shadowPage(container)).toContain("second-zh-Hans"));
  });
});
