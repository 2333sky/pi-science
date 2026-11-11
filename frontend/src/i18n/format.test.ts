import { afterEach, describe, expect, it } from "vitest";
import i18n from "./index";
import { formatDate, formatDateTime } from "./format";

// A fixed instant, rendered in a fixed time zone: the assertions must not
// depend on the machine's system time zone or system language.
const stamp = Date.UTC(2026, 10, 9, 21, 5, 7);
const options = { timeZone: "UTC" } as const;
const dateOptions = { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" } as const;
const dateTimeOptions = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", timeZone: "UTC" } as const;


afterEach(async () => {
  await i18n.changeLanguage("en");
});


describe("i18n date formatting", () => {
  it("formats date and time with the active app language, not the system locale", async () => {
    await i18n.changeLanguage("en");
    const english = formatDateTime(stamp, options);
    await i18n.changeLanguage("zh-Hans");
    const chinese = formatDateTime(stamp, options);

    expect(english).toBe(new Intl.DateTimeFormat("en", dateTimeOptions).format(new Date(stamp)));
    expect(chinese).toBe(new Intl.DateTimeFormat("zh-Hans", dateTimeOptions).format(new Date(stamp)));
    expect(english).not.toBe(chinese);
  });

  it("formats dates without time with the active app language", async () => {
    await i18n.changeLanguage("en");
    expect(formatDate(stamp, options)).toBe(new Intl.DateTimeFormat("en", dateOptions).format(new Date(stamp)));
    await i18n.changeLanguage("zh-Hans");
    expect(formatDate(stamp, options)).toBe(new Intl.DateTimeFormat("zh-Hans", dateOptions).format(new Date(stamp)));
  });

  it("keeps the app language for the default (no options) format", async () => {
    await i18n.changeLanguage("en");
    const english = formatDateTime(stamp);
    await i18n.changeLanguage("zh-Hans");
    expect(formatDateTime(stamp)).not.toBe(english);
  });

  it("returns unparsable input verbatim", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });
});
