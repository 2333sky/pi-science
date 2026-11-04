import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { getCACertificates } from "node:tls";
import { stageSystemCertificates } from "./system-certificates.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("node:tls", () => ({ getCACertificates: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); });
const missing = () => Object.assign(new Error("missing fixture bundle"), { code: "ENOENT" });

it("adds macOS-native trusted roots to the PEM bundle without granting Keychain access", async () => {
  vi.mocked(readFile).mockResolvedValue("BUNDLED_CA\n");
  vi.mocked(getCACertificates).mockReturnValue(["TRUSTED_SYSTEM_CA"]);
  expect(await stageSystemCertificates("scratch", "darwin")).toBe(join("scratch", "system-ca.pem"));
  expect(readFile).toHaveBeenCalledExactlyOnceWith("/etc/ssl/cert.pem", "utf8");
  expect(getCACertificates).toHaveBeenCalledExactlyOnceWith("system");
  expect(writeFile).toHaveBeenCalledExactlyOnceWith(join("scratch", "system-ca.pem"), "BUNDLED_CA\n\nTRUSTED_SYSTEM_CA", { mode: 0o600 });
});

it("uses native trusted roots when the macOS PEM bundle is absent", async () => {
  vi.mocked(readFile).mockRejectedValue(missing());
  vi.mocked(getCACertificates).mockReturnValue(["TRUSTED_SYSTEM_CA"]);
  expect(await stageSystemCertificates("scratch", "darwin")).toBe(join("scratch", "system-ca.pem"));
  expect(writeFile).toHaveBeenCalledWith(join("scratch", "system-ca.pem"), "TRUSTED_SYSTEM_CA", { mode: 0o600 });
});

it("preserves Linux bundle precedence without adding Node or user-supplied roots", async () => {
  vi.mocked(readFile).mockRejectedValueOnce(missing()).mockResolvedValueOnce("LINUX_CA");
  await stageSystemCertificates("scratch", "linux");
  expect(vi.mocked(readFile).mock.calls.map(call => call[0])).toEqual(["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"]);
  expect(getCACertificates).not.toHaveBeenCalled();
  expect(writeFile).toHaveBeenCalledWith(join("scratch", "system-ca.pem"), "LINUX_CA", { mode: 0o600 });
});

it("does not fabricate a trust bundle when no system roots are available", async () => {
  vi.mocked(readFile).mockRejectedValue(missing());
  vi.mocked(getCACertificates).mockReturnValue([]);
  expect(await stageSystemCertificates("scratch", "darwin")).toBeUndefined();
  expect(writeFile).not.toHaveBeenCalled();
});

it("propagates bundle read errors instead of treating a denied bundle as absent", async () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  vi.mocked(readFile).mockRejectedValue(denied);
  await expect(stageSystemCertificates("scratch", "darwin")).rejects.toBe(denied);
  expect(writeFile).not.toHaveBeenCalled();
});
