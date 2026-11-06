import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCACertificates, rootCertificates } from "node:tls";

const systemSources = (platform: NodeJS.Platform): string[] => platform === "darwin"
  ? ["/etc/ssl/cert.pem"] : ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"];

/** Confined curl, Python and Node read one PEM bundle from private scratch.
 * macOS's /etc/ssl/cert.pem can lag the roots the Node host trusts, so chains
 * ending at a newer root fail verification inside the sandbox; merge them in.
 * Certificate and hostname verification stay enabled, only trust material grows. */
export async function writeSandboxCaBundle(scratch: string, platform: NodeJS.Platform = process.platform, sources = systemSources(platform)): Promise<string> {
  const certificates = new Set<string>(platform === "darwin" ? [...rootCertificates, ...getCACertificates("system")] : []);
  for (const source of sources) {
    try { certificates.add(await readFile(source, "utf8")); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const path = join(scratch, "system-ca.pem");
  await writeFile(path, [...certificates].join("\n").trimEnd() + "\n", { mode: 0o600 });
  return path;
}
