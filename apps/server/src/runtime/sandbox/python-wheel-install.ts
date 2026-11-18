import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { normalizePythonPackageSpecs } from "../workspace/python-package-spec.js";
import { runEnvironmentProcess } from "./environment-process.js";

export interface PythonWheelArtifact {
  name: string;
  version: string;
  url: string;
  sha256: string;
}

const pipReport = z.object({
  install: z.array(
    z.object({
      is_direct: z.literal(false),
      metadata: z.object({ name: z.string(), version: z.string() }),
      download_info: z.object({
        url: z.url(),
        archive_info: z.object({
          hashes: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
        }),
      }),
    }),
  ),
});

const PYPI_DOMAINS = ["pypi.org:443", "files.pythonhosted.org:443"];

/** The caller owns the unpublished, independently built prefix and may discard it on failure. */
export async function installPythonWheels(
  micromamba: string,
  prefix: string,
  specs: readonly string[],
  constraints: readonly string[],
  signal?: AbortSignal,
): Promise<PythonWheelArtifact[]> {
  const packages = normalizePythonPackageSpecs(specs, 512);
  prefix = await realpath(prefix);
  const temporary = await mkdtemp(join(await realpath(tmpdir()), "pi-science-wheel-install-"));
  try {
    const constraintFile = join(temporary, "constraints.txt");
    await writeFile(constraintFile, constraints.join("\n"), { flag: "wx" });
    const python = join(prefix, "bin", "python");
    let artifacts: PythonWheelArtifact[] = [];
    await runEnvironmentProcess(
      micromamba,
      [
        "run",
        "--prefix",
        prefix,
        python,
        "-I",
        "-B",
        "-m",
        "pip",
        "--isolated",
        "--disable-pip-version-check",
        "--no-cache-dir",
        "--no-input",
        "--quiet",
        "install",
        "--index-url",
        "https://pypi.org/simple",
        "--only-binary=:all:",
        "--constraint",
        constraintFile,
        "--no-compile",
        "--report",
        "-",
        "--",
        ...packages,
      ],
      prefix,
      temporary,
      180_000,
      {
        MAMBA_ROOT_PREFIX: temporary,
        MAMBA_NO_RC: "true",
        PIP_CONFIG_FILE: "/dev/null",
      },
      {
        requireSandbox: true,
        restrictNetworkTo: PYPI_DOMAINS,
        signal,
        stdout: (output) => {
          artifacts = pipReport
            .parse(JSON.parse(output))
            .install.map(({ download_info, metadata }) => {
              const url = new URL(download_info.url);
              if (
                url.protocol !== "https:" ||
                url.username ||
                url.password ||
                url.port ||
                !PYPI_DOMAINS.includes(`${url.hostname}:443`) ||
                !url.pathname.endsWith(".whl")
              ) {
                throw new Error("Python package did not resolve to a wheel from PyPI");
              }
              return {
                name: metadata.name,
                version: metadata.version,
                url: download_info.url,
                sha256: download_info.archive_info.hashes.sha256,
              };
            });
        },
      },
    );
    await runEnvironmentProcess(
      python,
      ["-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check", "check"],
      prefix,
      undefined,
      30_000,
      { PIP_CONFIG_FILE: "/dev/null" },
      {
        requireSandbox: true,
        restrictNetworkTo: [],
        signal,
      },
    );
    return artifacts;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function resolvedPythonPackages(
  python: string,
  prefix: string,
  signal?: AbortSignal,
): Promise<string[]> {
  let packages: unknown;
  await runEnvironmentProcess(
    python,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import importlib.metadata as m, sysconfig, json; paths = sysconfig.get_paths(); print(json.dumps([[d.metadata['Name'], d.version] for d in m.distributions(path=sorted({paths['purelib'], paths['platlib']}))]))",
    ],
    prefix,
    undefined,
    30_000,
    {},
    {
      requireSandbox: true,
      restrictNetworkTo: [],
      signal,
      stdout: (output) => {
        packages = JSON.parse(output);
      },
    },
  );
  if (!Array.isArray(packages)) throw new Error("Invalid Python package inventory");
  const pins = packages.map((item: unknown) => {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      typeof item[0] !== "string" ||
      typeof item[1] !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/i.test(item[0]) ||
      !/^[a-z0-9][a-z0-9._+!-]*$/i.test(item[1])
    ) {
      throw new Error("Invalid Python package metadata in environment");
    }
    return `${item[0].toLowerCase().replace(/[-_.]+/g, "-")}==${item[1]}`;
  });
  if (new Set(pins.map((pin) => pin.split("==", 1)[0])).size !== pins.length) {
    throw new Error("Duplicate Python distribution metadata in environment");
  }
  return pins.sort();
}
