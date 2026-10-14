import { combinedHash, PROVIDER_SEARCHERS } from "./providers.js";
import {
  DEFAULT_PROVIDERS,
  isProviderId,
  type LiteratureProviderId,
  type LiteratureSearchOutcome,
  type LiteratureSearchResult,
  type ProviderFailure,
} from "./types.js";

/** Literature retrieval with caching, deduplication and isolated provider failures. */

interface CacheEntry {
  result: LiteratureSearchResult;
  expiresAt: number;
}

export interface LiteratureServiceOptions {
  cacheTtlMs?: number;
  now?: () => number;
  maxQueryLength?: number;
  cache?: Map<string, CacheEntry>;
}

const DEFAULT_CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_QUERY_LENGTH = 500;

export class LiteratureService {
  private readonly cache: Map<string, CacheEntry>;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly maxQueryLength: number;

  constructor(options: LiteratureServiceOptions = {}) {
    this.cache = options.cache ?? new Map();
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.maxQueryLength = options.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH;
  }

  /** Validate the query shape; throws Error with a user-facing message. */
  private normalizeQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("query is required");
    if (trimmed.length > this.maxQueryLength) throw new Error(`query exceeds ${this.maxQueryLength} characters`);
    return trimmed;
  }

  async search(
    query: string,
    options: { providers?: readonly LiteratureProviderId[] } = {},
  ): Promise<LiteratureSearchOutcome> {
    const normalized = this.normalizeQuery(query);
    const requested = options.providers && options.providers.length > 0 ? options.providers.filter(isProviderId) : DEFAULT_PROVIDERS;
    const results: LiteratureSearchResult[] = [];
    const failures: ProviderFailure[] = [];

    await Promise.all(
      requested.map(async (provider) => {
        const cacheKey = `${provider}:${normalized.toLowerCase()}`;
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > this.now()) {
          results.push({ ...cached.result, cached: true });
          return;
        }
        try {
          const { result, rawBodies } = await PROVIDER_SEARCHERS[provider](normalized);
          const stored: LiteratureSearchResult = { ...result, responseHash: combinedHash(rawBodies) };
          this.cache.set(cacheKey, { result: stored, expiresAt: this.now() + this.cacheTtlMs });
          results.push(stored);
        } catch (error) {
          failures.push({ provider, error: error instanceof Error ? error.message : String(error) });
        }
      }),
    );

    return { results: deduplicate(results), failures };
  }
}

/** Merge results across providers by stable identifier (DOI first, then provider:id). */
export function deduplicate(results: LiteratureSearchResult[]): LiteratureSearchResult[] {
  const seen = new Set<string>();
  return results.map((result) => ({
    ...result,
    records: result.records.filter((record) => {
      const key = record.doi?.toLowerCase() || `${record.provider}:${record.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  }));
}
