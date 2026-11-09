import { afterEach, describe, expect, it, vi } from "vitest";

const RealDateTimeFormat = Intl.DateTimeFormat;

async function bytesFor(build: (sheet: { addRow(values: unknown[]): unknown }) => void): Promise<ArrayBuffer> {
  const { Workbook } = await import("exceljs");
  const workbook = new Workbook();
  build(workbook.addWorksheet("Data"));
  const buffer = await workbook.xlsx.writeBuffer();
  return Uint8Array.from(buffer as unknown as Uint8Array).buffer;
}

async function freshXlsx() {
  vi.resetModules();
  return await import("./xlsx");
}

function dateSheet(sheet: { addRow(values: unknown[]): unknown }, rows: number, columns: number): void {
  const base = Date.UTC(2026, 0, 1);
  for (let row = 0; row < rows; row++) {
    const cells: Date[] = [];
    for (let column = 0; column < columns; column++) {
      cells.push(new Date(base + (row * columns + column) * 86_400_000));
    }
    sheet.addRow(cells);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("xlsx preview sheets", () => {
  it("reports the rendered row count and truncation at the 600-row clamp", async () => {
    const { workbookSheets } = await freshXlsx();
    const counted = (count: number) => bytesFor((sheet) => {
      for (let row = 0; row < count; row++) sheet.addRow([row]);
    });

    const atLimit = await workbookSheets(await counted(600), "en");
    expect(atLimit[0].rows).toBe(600);
    expect(atLimit[0].truncated).toBe(false);

    const overLimit = await workbookSheets(await counted(601), "en");
    expect(overLimit[0].rows).toBe(600);
    expect(overLimit[0].truncated).toBe(true);
  });

  it("builds one date formatter per locale for a date-heavy sheet", async () => {
    const bytes = await bytesFor((sheet) => dateSheet(sheet, 100, 20));

    const built: Array<string | undefined> = [];
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
      this: unknown,
      locale?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) {
      built.push(Array.isArray(locale) ? locale[0] : locale);
      return new RealDateTimeFormat(locale, options);
    } as unknown as typeof Intl.DateTimeFormat);

    const { workbookSheets } = await freshXlsx();

    const english = await workbookSheets(bytes, "en");
    const buildCountAfterEnglish = built.length;
    const chinese = await workbookSheets(bytes, "zh-Hans");

    expect(english[0].html).toContain("1/1/2026");
    expect(chinese[0].html).toContain("2026/1/1");
    expect(built.slice(0, buildCountAfterEnglish)).toEqual(["en"]);
    expect(built.slice(buildCountAfterEnglish)).toEqual(["zh-Hans"]);
  });
});
