import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EvaluatorRegistry } from "../runtime/evaluation/evaluator-registry.js";

// Deliberately offline. OS access to the private registry is the operator authority.
// No HTTP route, Worker import, model flag or environment fallback enables registration.
async function main() {
  const [command, root, workspace, ...args] = process.argv.slice(2);
  if (!root || !workspace || !["register", "revoke", "verify"].includes(command ?? "")) throw new Error("Usage: evaluator-registry <register|revoke|verify> <private-root> <workspace> <registration.json evaluator-dir dataset-dir environment-dir | revision-id>");
  const configured: unknown = JSON.parse(process.env.PI_SCIENCE_SANDBOX_RUNTIME_PATHS ?? "[]");
  if (!Array.isArray(configured) || configured.some((path) => typeof path !== "string")) throw new Error("Invalid operator runtime paths");
  const runtimeRoots = [...configured as string[], ...[process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT, process.env.PI_SCIENCE_ENVIRONMENT_PREFIX].filter((path): path is string => !!path)];
  const registry = new EvaluatorRegistry(resolve(root), [resolve(workspace)], runtimeRoots);
  if (command === "register") {
    const [manifest, evaluator, dataset, environment] = args;
    if (args.length !== 4 || !manifest || !evaluator || !dataset || !environment) throw new Error("Registration requires a manifest and three frozen source directories");
    const revision = await registry.register(JSON.parse(await readFile(resolve(manifest), "utf8")), { evaluator: resolve(evaluator), dataset: resolve(dataset), environment: resolve(environment) });
    console.log(JSON.stringify({ revision_id: revision.id, status: "registered", scoring_available: false }));
  } else {
    if (args.length !== 1 || !args[0]) throw new Error("Expected one revision ID");
    if (command === "revoke") await registry.revoke(args[0]); else await registry.load(args[0]);
    console.log(JSON.stringify({ revision_id: args[0], status: command === "revoke" ? "revoked" : "verified", scoring_available: false }));
  }
}
main().catch(() => { console.error("Evaluator registry operation rejected; check private-root permissions, registration and immutable assets."); process.exitCode = 1; });
