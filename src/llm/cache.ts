/**
 * LLM call cache. Key = sha256 of the full request (provider, model, messages, tools, params), so an identical
 * request always maps to the same stored response.
 *
 *   live   : call the model; write every response to the cache (a cache hit is still used, and recorded as a hit)
 *   replay : cache only; a miss is a hard error (the run cannot be reproduced without the model)
 *   off    : always call the model; write nothing
 *
 * Entries are small JSON files under llm-cache/, committed to the repo so reviewers can replay runs without a model.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../world/dataset.js";

export type CacheMode = "live" | "replay" | "off";
export const DEFAULT_CACHE_DIR = join(REPO_ROOT, "llm-cache");

export class CacheMissError extends Error {
  constructor(key: string) { super(`replay mode: no cached LLM response for request ${key.slice(0, 12)}… (run once in live mode first)`); this.name = "CacheMissError"; }
}

export interface CachedResponse { key: string; request: unknown; response: unknown; latency_ms: number; created_at: string }

export function requestKey(request: unknown): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

/** JSON.stringify with sorted object keys, so key order never changes the hash. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export class LlmCache {
  constructor(readonly mode: CacheMode, private readonly dir: string = DEFAULT_CACHE_DIR) {}

  private path(key: string): string { return join(this.dir, key.slice(0, 2), `${key}.json`); }

  get(key: string): CachedResponse | null {
    if (this.mode === "off") return null;
    const p = this.path(key);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CachedResponse) : null;
  }

  put(entry: CachedResponse): void {
    if (this.mode !== "live") return;
    const p = this.path(entry.key);
    mkdirSync(join(this.dir, entry.key.slice(0, 2)), { recursive: true });
    writeFileSync(p, JSON.stringify(entry, null, 2) + "\n", "utf8");
  }
}
