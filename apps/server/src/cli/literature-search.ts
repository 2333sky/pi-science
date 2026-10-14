import { pathToFileURL } from "node:url";
import { LiteratureService } from "../literature/literature-service.js";
import { DEFAULT_PROVIDERS, isProviderId, type LiteratureProviderId } from "../literature/types.js";

/** Search-only fallback: no approval issuance or caller-supplied approval tokens. */
export async function searchLiterature(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected a JSON object");
  const request = input as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== "query" && key !== "providers")) {
    throw new Error("only query and providers are supported; sensitive queries require an authorized MCP connector");
  }
  if (typeof request.query !== "string") throw new Error("query is required");
  let providers: LiteratureProviderId[] | undefined;
  if (request.providers !== undefined) {
    if (!Array.isArray(request.providers) || request.providers.length === 0 || request.providers.some((p) => typeof p !== "string" || !isProviderId(p))) {
      throw new Error(`providers must be a non-empty subset of: ${DEFAULT_PROVIDERS.join(", ")}`);
    }
    providers = [...new Set(request.providers)] as LiteratureProviderId[];
  }
  return new LiteratureService().search(request.query, { providers });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Read JSON from stdin so query text does not become shell code or an argv entry.
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (input.length > 16_384) throw new Error("input exceeds 16384 characters");
    }
    const outcome = await searchLiterature(JSON.parse(input));
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    if (outcome.blocked) process.exitCode = 2;
    else if (outcome.failures.length > 0 && outcome.results.length === 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
