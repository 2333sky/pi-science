import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { afterEach, expect, it } from "vitest";
import { writeSandboxCaBundle } from "./certificates.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function scratch() { const root = await mkdtemp(join(tmpdir(), "sandbox-ca-")); roots.push(root); return root; }

it("merges the Node host roots with the macOS bundle so a truncated OS file still verifies", async () => {
  const root = await scratch(), source = join(root, "system.pem");
  const truncated = "-----BEGIN CERTIFICATE-----\nTRUNCATED\n-----END CERTIFICATE-----\n";
  await writeFile(source, truncated);
  const path = await writeSandboxCaBundle(root, "darwin", [source]);
  const bundle = await readFile(path, "utf8");
  for (const certificate of rootCertificates) expect(bundle).toContain(certificate);
  expect(bundle).toContain(truncated);
  expect(await readFile(source, "utf8")).toBe(truncated);
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("still provides Node host roots when the macOS bundle is absent", async () => {
  const root = await scratch();
  const bundle = await readFile(await writeSandboxCaBundle(root, "darwin", [join(root, "missing.pem")]), "utf8");
  expect(bundle).toContain(rootCertificates[0]);
});

it("keeps the distribution bundle authoritative on Linux without adding Node roots", async () => {
  const root = await scratch(), source = join(root, "ca-certificates.crt");
  await writeFile(source, "-----BEGIN CERTIFICATE-----\nDISTRO\n-----END CERTIFICATE-----\n");
  const bundle = await readFile(await writeSandboxCaBundle(root, "linux", [source]), "utf8");
  expect(bundle).toBe("-----BEGIN CERTIFICATE-----\nDISTRO\n-----END CERTIFICATE-----\n");
  expect(bundle).not.toContain(rootCertificates[0]);
});

it("propagates an unreadable bundle instead of silently replacing the trust policy", async () => {
  const root = await scratch();
  await expect(writeSandboxCaBundle(root, "linux", [root])).rejects.toThrow();
});
