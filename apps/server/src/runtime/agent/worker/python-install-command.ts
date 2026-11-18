import { normalizePythonPackageSpecs } from "../../workspace/python-package-spec.js";

export function parsePythonInstallCommand(command: string): string[] | null {
  const match = /^[ \t]*python3?[ \t]+-m[ \t]+pip[ \t]+install[ \t]+([^\r\n]+)$/.exec(command);
  if (!match || /[\r\n]/.test(command)) return null;
  const args = match[1]!
    .replace(/[ \t]+$/, "")
    .split(/[ \t]+/)
    .map((arg) => {
      if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'")))
        return arg.slice(1, -1);
      return /[<>*[\]]/.test(arg) ? "" : arg;
    });
  try {
    return normalizePythonPackageSpecs(args);
  } catch {
    return null;
  }
}
