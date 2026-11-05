// Retains parsed pull request diffs on the executor that read them. A diff is a
// pure function of its repository and commit pair, so entries never go stale;
// they are only evicted. Readers still prove current access through `gh` before
// a cached diff is returned, which keeps the active account out of the key.

import { BoundedLruCache } from '../../../common/bounded-lru-cache.js';
import { KeyedPromiseLock } from '../../common/keyed-lock.js';
import type { GhRepositoryIdentity, PullRequestCommits, PullRequestDiff } from '../../../common/gh.js';

const MAX_ENTRIES = 16;
const MAX_BYTES = 32 * 1024 * 1024;
const FILE_OVERHEAD_BYTES = 1024;

export interface PullRequestDiffKey {
  readonly repository: GhRepositoryIdentity;
  readonly number: number;
  readonly commits: PullRequestCommits;
}

function cacheKey({ repository, number, commits }: PullRequestDiffKey): string {
  return JSON.stringify([repository.host.toLowerCase(), repository.nameWithOwner.toLowerCase(), number, commits.baseRefOid, commits.headRefOid]);
}

// Strings are UTF-16 in memory; per-file overhead covers summaries and metadata.
export function estimatePullRequestDiffBytes(diff: PullRequestDiff): number {
  let bytes = 0;
  for (const body of Object.values(diff.fileBodies)) bytes += (body.patch?.length ?? 0) * 2 + FILE_OVERHEAD_BYTES;
  return bytes + diff.files.length * FILE_OVERHEAD_BYTES;
}

export class PullRequestDiffCache {
	readonly #loads = new KeyedPromiseLock();
  readonly #entries = new BoundedLruCache<string, PullRequestDiff>({ maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES, sizeOf: estimatePullRequestDiffBytes });

  get(key: PullRequestDiffKey): PullRequestDiff | undefined {
    return this.#entries.get(cacheKey(key));
  }

  set(key: PullRequestDiffKey, diff: PullRequestDiff): void {
    this.#entries.set(cacheKey(key), diff);
  }

  // Serializes misses without sharing a caller's credentials, cancellation, or operation context.
  load(key: PullRequestDiffKey, read: () => Promise<PullRequestDiff>, signal?: AbortSignal): Promise<PullRequestDiff> {
    return this.#loads.runExclusive(cacheKey(key), async () => {
      const cached = this.get(key);
      if (cached) return cached;
      const result = await read();
      signal?.throwIfAborted();
      this.set(key, result);
      return result;
    }, signal);
  }

  get size(): number { return this.#entries.size; }

  clear(): void { this.#entries.clear(); }
}
