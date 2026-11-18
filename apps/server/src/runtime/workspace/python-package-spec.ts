const name = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
const version = "[a-z0-9][a-z0-9._+!*-]*";
const constraint = `(?:==|!=|~=|<=|>=|<|>)${version}`;
const packageSpec = new RegExp(
  `^(${name})(?:\\[(${name}(?:,${name})*)\\])?(${constraint}(?:,${constraint})*)?$`,
  "i",
);

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[-_.]+/g, "-");
}

export function normalizePythonPackageSpecs(specs: readonly string[], limit = 32): string[] {
  if (specs.length === 0 || specs.length > limit)
    throw new Error(`Specify between 1 and ${limit} Python packages`);
  const normalized = specs.map((spec) => {
    const match =
      spec.length <= 256 && !/\s/.test(spec) && !/\.(?:whl|zip|tar|gz|bz2|xz|tgz)$/i.test(spec)
        ? packageSpec.exec(spec)
        : null;
    if (!match)
      throw new Error(
        "Expected a Python package name with optional extras and version constraints",
      );
    const extras = match[2] ? [...new Set(match[2].split(",").map(normalizeName))].sort() : [];
    return (
      normalizeName(match[1]!) + (extras.length ? `[${extras.join(",")}]` : "") + (match[3] ?? "")
    );
  });
  return [...new Set(normalized)];
}
