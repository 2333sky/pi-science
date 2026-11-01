import { describe, expect, it } from "vitest";

import { cn } from "./cn";

/** The `ui-*` steps are font sizes (tailwind.config.js `fontSize.ui-*`), so
 *  they must merge with colour classes instead of replacing them. */
const uiSizes = ["text-ui-micro", "text-ui-meta", "text-ui-caption", "text-ui-label", "text-ui-body", "text-ui-title"];

describe("cn", () => {
  it("keeps a ui font size and a text colour together, whichever order they arrive in", () => {
    expect(cn("text-ui-label", "text-muted")).toBe("text-ui-label text-muted");
    expect(cn("text-muted", "text-ui-label")).toBe("text-muted text-ui-label");
  });

  it("still lets a later font size win over an earlier one", () => {
    expect(cn("text-sm", "text-ui-label")).toBe("text-ui-label");
    expect(cn("text-ui-label", "text-sm")).toBe("text-sm");
  });

  it("keeps every ui step next to a colour class", () => {
    for (const size of uiSizes) {
      expect(cn(size, "text-muted")).toBe(`${size} text-muted`);
      expect(cn("text-muted", size)).toBe(`text-muted ${size}`);
    }
  });

  it("keeps the default tailwind font sizes working", () => {
    expect(cn("text-xs", "text-muted")).toBe("text-xs text-muted");
    expect(cn("text-muted", "text-xs")).toBe("text-muted text-xs");
  });
});
