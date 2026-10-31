// Retains the validator and body of each conditional REST read on the executor
// that made it. GitHub answers an unchanged resource with 304 Not Modified, and
// the reader reuses the body kept here. Responses differ by credential, so each
// entry is scoped by a digest of the token `gh` sends for its host: one
// account's validator never revalidates another account's body. A 304 still
// needs a round trip that GitHub authorizes, so a cached body is only returned
// while the current account can read the resource. A refusal forgets every
// entry of that repository.

import { BoundedLruCache } from '../../../common/bounded-lru-cache.js';
import type { GhRepositoryIdentity } from '../../../common/gh.js';

const MAX_ENTRIES = 256;
const MAX_BYTES = 16 * 1024 * 1024;
const ENTRY_OVERHEAD_BYTES = 256;

export interface GhResponseKey {
  // Digest of the host and credential the request is sent with.
  readonly account: string;
  readonly repository: GhRepositoryIdentity;
  // The REST path including its query, such as one page of a listing.
  readonly path: string;
}

export interface GhCachedResponse {
  readonly etag: string;
  readonly body: string;
  readonly hasNextPage: boolean;
}

interface Entry extends GhCachedResponse {
  readonly repository: string;
}

function repositoryKey(repository: GhRepositoryIdentity): string {
  return JSON.stringify([repository.host.toLowerCase(), repository.nameWithOwner.toLowerCase()]);
}

function cacheKey(key: GhResponseKey): string {
  return JSON.stringify([key.account, repositoryKey(key.repository), key.path]);
}

export class GhResponseCache {
  readonly #entries = new BoundedLruCache<string, Entry>({
    maxEntries: MAX_ENTRIES,
    maxBytes: MAX_BYTES,
    // Strings are UTF-16 in memory.
    sizeOf: (entry) => (entry.body.length + entry.etag.length) * 2 + ENTRY_OVERHEAD_BYTES,
  });

  get(key: GhResponseKey): GhCachedResponse | undefined {
    return this.#entries.get(cacheKey(key));
  }

  set(key: GhResponseKey, response: GhCachedResponse): void {
    this.#entries.set(cacheKey(key), { ...response, repository: repositoryKey(key.repository) });
  }

  delete(key: GhResponseKey): void {
    this.#entries.delete(cacheKey(key));
  }

  // Drops every account's entries for a repository GitHub refused to read.
  forgetRepository(repository: GhRepositoryIdentity): void {
    const forgotten = repositoryKey(repository);
    this.#entries.deleteWhere((_key, entry) => entry.repository === forgotten);
  }

  get size(): number { return this.#entries.size; }

  clear(): void { this.#entries.clear(); }
}
