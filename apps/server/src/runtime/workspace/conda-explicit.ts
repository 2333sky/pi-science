import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readCondaExplicit(prefix: string): Promise<string> {
  const root = join(prefix, "conda-meta");
  const records = (await readdir(root)).filter((file) => file.endsWith(".json")).sort();
  if (!records.length) throw new Error("The current revision has no Conda package records");
  const entries = await Promise.all(
    records.map(async (file) => {
      const { url, md5 } = JSON.parse(await readFile(join(root, file), "utf8")) as {
        url?: unknown;
        md5?: unknown;
      };
      if (
        typeof url !== "string" ||
        !/^https:\/\/conda\.anaconda\.org\/conda-forge\/(?:linux-(?:64|aarch64)|osx-(?:64|arm64)|noarch)\/[a-zA-Z0-9_.+-]+\.(?:conda|tar\.bz2)$/.test(
          url,
        ) ||
        typeof md5 !== "string" ||
        !/^[a-f0-9]{32}$/i.test(md5)
      ) {
        throw new Error(
          `Cannot rebuild Conda package with unsupported source or missing checksum: ${file}`,
        );
      }
      return `${url}#${md5}`;
    }),
  );
  return `@EXPLICIT\n${entries.join("\n")}\n`;
}
