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
    expect(atLimit[0].truncatedRows).toBe(false);
    expect(atLimit[0].truncatedColumns).toBe(false);

    const overLimit = await workbookSheets(await counted(601), "en");
    expect(overLimit[0].rows).toBe(600);
    expect(overLimit[0].truncatedRows).toBe(true);
    expect(overLimit[0].truncatedColumns).toBe(false);
  });

  it("separates the column clamp from the row clamp", async () => {
    const { workbookSheets } = await freshXlsx();
    const grid = (rows: number, columns: number) => bytesFor((sheet) => {
      for (let row = 0; row < rows; row++) {
        const cells: string[] = [];
        for (let column = 0; column < columns; column++) cells.push(`r${row}c${column}`);
        sheet.addRow(cells);
      }
    });

    // 3 × 81: only the column dimension is over its limit.
    const wide = await workbookSheets(await grid(3, 81), "en");
    expect(wide[0].rows).toBe(3);
    expect(wide[0].columns).toBe(80);
    expect(wide[0].truncatedRows).toBe(false);
    expect(wide[0].truncatedColumns).toBe(true);

    // 601 × 3: only the row dimension is over its limit.
    const tall = await workbookSheets(await grid(601, 3), "en");
    expect(tall[0].rows).toBe(600);
    expect(tall[0].columns).toBe(3);
    expect(tall[0].truncatedRows).toBe(true);
    expect(tall[0].truncatedColumns).toBe(false);

    // Inside both limits: nothing to report.
    const small = await workbookSheets(await grid(2, 80), "en");
    expect(small[0].rows).toBe(2);
    expect(small[0].columns).toBe(80);
    expect(small[0].truncatedRows).toBe(false);
    expect(small[0].truncatedColumns).toBe(false);
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
