import fs from "fs";

export const DIG_CACHE_FILE = "/tmp/ai-daily-dig-cache.json";
export const DIG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type DigCacheEntry = {
  articleUrl: string;
  markdown: string;
  createdAt: string; // ISO timestamp
};

export type DigCache = {
  entries: DigCacheEntry[];
};

const DEFAULT_CACHE: DigCache = { entries: [] };

/** Ensure the cache file exists with an empty structure. Safe to call multiple times. */
export function initializeDigCache(): void {
  try {
    if (!fs.existsSync(DIG_CACHE_FILE)) {
      fs.writeFileSync(DIG_CACHE_FILE, JSON.stringify(DEFAULT_CACHE, null, 2));
    }
  } catch (_e: unknown) {
    // ignore; reading will still be resilient
  }
}

/** Resilient read of the dig cache JSON. Returns default on error or bad shape. */
export function readDigCache(): DigCache {
  try {
    if (!fs.existsSync(DIG_CACHE_FILE)) return { ...DEFAULT_CACHE };
    const raw = fs.readFileSync(DIG_CACHE_FILE, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    // Backward compatibility: old entries may include a `language` field.
    // Normalize by collapsing to the newest non-expired entry per articleUrl.
    if (isValidCache(parsed)) return parsed as DigCache;
    const maybe = parsed as { entries?: Array<Record<string, unknown>> };
    const list = Array.isArray(maybe.entries) ? maybe.entries : [];
    const byUrl = new Map<string, { articleUrl: string; markdown: string; createdAt: string }>();
    for (const e of list) {
      const url = typeof e.articleUrl === 'string' ? e.articleUrl : '';
      const markdown = typeof e.markdown === 'string' ? e.markdown : '';
      const createdAt = typeof e.createdAt === 'string' ? e.createdAt : '';
      if (!url || !markdown || !createdAt) continue;
      const existing = byUrl.get(url);
      if (!existing || Date.parse(createdAt) > Date.parse(existing.createdAt)) {
        byUrl.set(url, { articleUrl: url, markdown, createdAt });
      }
    }
    const entries = Array.from(byUrl.values());
    return { entries };
  } catch (_e: unknown) {
    return { ...DEFAULT_CACHE };
  }
}

/** Write the dig cache with pretty printing (2 spaces). */
export function writeDigCache(cache: DigCache): void {
  fs.writeFileSync(DIG_CACHE_FILE, JSON.stringify(cache, null, 2));
}

/** Remove entries older than TTL and persist. Returns the pruned cache. */
export function pruneDigCache(now: Date = new Date()): DigCache {
  const cache = readDigCache();
  const pruned = cache.entries.filter((e) => !isExpired(e, now));
  const result: DigCache = { entries: pruned };
  writeDigCache(result);
  return result;
}

/** Return a non-expired cached entry for the given articleUrl, or null. */
export function getCachedDig(
  articleUrl: string,
  now: Date = new Date(),
): DigCacheEntry | null {
  const cache = readDigCache();
  const entry = cache.entries.find(
    (e) => e.articleUrl === articleUrl,
  );
  if (!entry) return null;
  if (isExpired(entry, now)) return null;
  return entry;
}

/** Upsert a cached entry and prune old entries. */
export function setCachedDig(
  articleUrl: string,
  markdown: string,
  now: Date = new Date(),
): void {
  const cache = readDigCache();
  const createdAt = now.toISOString();
  const index = cache.entries.findIndex(
    (e) => e.articleUrl === articleUrl,
  );
  const newEntry: DigCacheEntry = { articleUrl, markdown, createdAt };
  if (index >= 0) {
    cache.entries[index] = newEntry;
  } else {
    cache.entries.push(newEntry);
  }
  // prune then write
  const pruned = cache.entries.filter((e) => !isExpired(e, now));
  writeDigCache({ entries: pruned });
}

/** Determine whether a cache entry is expired at the given time. */
/** Determine whether a cache entry is expired at the given time. */
function isExpired(entry: DigCacheEntry, now: Date): boolean {
  const created = Date.parse(entry.createdAt);
  return isNaN(created) || now.getTime() - created > DIG_TTL_MS;
}

/** Narrow unknown to DigCache shape. */
function isValidCache(value: unknown): value is DigCache {
  if (!value || typeof value !== "object") return false;
  const v = value as { entries?: unknown };
  if (!Array.isArray(v.entries)) return false;
  for (const e of v.entries) {
    if (!e || typeof e !== "object") return false;
    const o = e as Record<string, unknown>;
    if (
      typeof o.articleUrl !== "string" ||
      typeof o.markdown !== "string" ||
      typeof o.createdAt !== "string"
    ) {
      return false;
    }
  }
  return true;
}
