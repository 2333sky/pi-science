import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspacePolicy } from "./policy.js";
import { prepareSandbox } from "./process.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const pemBlocks = (bundle: string) => bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];

describe.skipIf(process.platform !== "darwin")("sandbox CA bundle", () => {
  it("trusts every root of the system keychain, not only the legacy file bundle", async () => {
    const root = await mkdtemp(join("/private/tmp", "ps-ca-")); roots.push(root);
    const prepared = await prepareSandbox(await workspacePolicy(root, undefined, "analysis"), ["/bin/true"], [], 5);
    try {
      const manifest = JSON.parse(await readFile(prepared.manifest, "utf8")), bundle = await readFile(manifest.env.SSL_CERT_FILE, "utf8");
      expect(manifest.env.CURL_CA_BUNDLE).toBe(manifest.env.SSL_CERT_FILE);
      const trusted = new Set(pemBlocks(bundle)), missing = (source: string) => pemBlocks(source).filter((certificate) => !trusted.has(certificate)).length;
      // example.com's certificate chain roots at SSL.com TLS ECC Root CA 2022,
      // which macOS keeps in the keychain and leaves out of /etc/ssl/cert.pem.
      expect(missing(execFileSync("/usr/bin/security", ["find-certificate", "-a", "-p", "/System/Library/Keychains/SystemRootCertificates.keychain"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }))).toBe(0);
      expect(missing(await readFile("/etc/ssl/cert.pem", "utf8"))).toBe(0);
      expect(pemBlocks(bundle).length).toBeGreaterThan(pemBlocks(await readFile("/etc/ssl/cert.pem", "utf8")).length);
    } finally { await prepared.cleanup(); }
  }, 60_000);
});
