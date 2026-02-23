// Caches project path availability so getChats() doesn't hit fs.access
// on every request. Each entry is checked lazily and cached with a TTL.

import { promises as fs } from 'fs';

const DEFAULT_STALE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SIZE = 1024;

export class PathCache {
  #cache = new Map();
  #ttlMs;
  #maxSize;

  constructor({ ttlMs = DEFAULT_STALE_MS, maxSize = DEFAULT_MAX_SIZE } = {}) {
    this.#ttlMs = ttlMs;
    this.#maxSize = maxSize;
  }

  async isProjectPathAvailable(projectPath) {
    if (!projectPath) return false;

    const entry = this.#cache.get(projectPath);
    const now = Date.now();

    if (entry && (now - entry.checkedAt) < this.#ttlMs) {
      return entry.available;
    }

    const available = await PathCache.#checkPath(projectPath);
    this.#cache.delete(projectPath);
    this.#cache.set(projectPath, { available, checkedAt: now });
    this.#pruneIfNeeded();
    return available;
  }

  #pruneIfNeeded() {
    if (this.#cache.size <= this.#maxSize) return;
    const toDelete = this.#cache.size - this.#maxSize;
    let deleted = 0;
    for (const key of this.#cache.keys()) {
      if (deleted >= toDelete) break;
      this.#cache.delete(key);
      deleted++;
    }
  }

  static async #checkPath(p) {
    try {
      const stat = await fs.stat(p);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
