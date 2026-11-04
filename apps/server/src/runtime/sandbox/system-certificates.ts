import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCACertificates } from "node:tls";

/** Export only public CA certificates into the existing scratch read grant.
 * macOS's PEM bundle omits additional roots trusted through the native store. */
export async function stageSystemCertificates(scratch: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const certificates: string[] = [];
  for (const source of platform === "darwin" ? ["/etc/ssl/cert.pem"] : ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"]) {
    try { certificates.push(await readFile(source, "utf8")); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // Node applies the platform's trust settings. Do not export every certificate
  // found in a Keychain, which could promote an untrusted certificate to a root.
  if (platform === "darwin") certificates.push(...getCACertificates("system"));
  if (!certificates.length) return undefined;
  const path = join(scratch, "system-ca.pem");
  await writeFile(path, certificates.join("\n"), { mode: 0o600 });
  return path;
}
