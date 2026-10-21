import { expect, it } from "vitest";
import { redactMcpError } from "./diagnostics.js";
it("redacts authorization values and URL credentials/query strings from visible diagnostics", () => {
  const redacted = redactMcpError("Authorization: Bearer private-token api_key=secret https://user:password@example.com/mcp?token=secret");
  expect(redacted).not.toContain("private-token"); expect(redacted).not.toContain("secret"); expect(redacted).not.toContain("password"); expect(redacted).toContain("https://example.com");
});
