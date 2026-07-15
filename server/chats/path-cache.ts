// Caches canonical project identity so chat-list reads avoid repeated filesystem work.

import { promises as fs } from 'fs';
import { mapWithConcurrencyResult } from '../lib/concurrency.js';
import {
  assertRealWithinProjectBase,
  isProjectBoundaryError,
} from '../lib/path-boundary.js';

const DEFAULT_STALE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SIZE = 1024;

interface PathCacheOptions {
  ttlMs?: number;
  maxSize?: number;
}

interface PathCacheEntry {
  status: ProjectPathStatus;
  checkedAt: number;
}

export interface ProjectPathStatus {
  available: boolean;
  effectiveProjectKey: string | null;
}

export class PathCache {
  #cache = new Map<string, PathCacheEntry>();
  #ttlMs: number;
  #maxSize: number;

  constructor({
    ttlMs = DEFAULT_STALE_MS,
    maxSize = DEFAULT_MAX_SIZE,
  }: PathCacheOptions = {}) {
    this.#ttlMs = ttlMs;
    this.#maxSize = maxSize;
  }

  async resolveProjectPath(
    projectPath: string | null | undefined,
  ): Promise<ProjectPathStatus> {
    if (!projectPath) return { available: false, effectiveProjectKey: null };

    const entry = this.#cache.get(projectPath);
    const now = Date.now();

    if (entry && now - entry.checkedAt < this.#ttlMs) {
      return entry.status;
    }

    const status = await PathCache.#resolvePath(projectPath);
    this.#cache.delete(projectPath);
    this.#cache.set(projectPath, { status, checkedAt: now });
    this.#pruneIfNeeded();
    return status;
  }

  async resolveProjectPaths(
    projectPaths: readonly string[],
    concurrency = 8,
  ): Promise<Map<string, ProjectPathStatus>> {
    const uniquePaths = [...new Set(projectPaths.filter(Boolean))];
    const resolved = await mapWithConcurrencyResult(
      uniquePaths,
      concurrency,
      async (projectPath) =>
        [projectPath, await this.resolveProjectPath(projectPath)] as const,
    );
    return new Map(resolved);
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

  static async #resolvePath(projectPath: string): Promise<ProjectPathStatus> {
    try {
      const canonical = await assertRealWithinProjectBase(projectPath);
      const stat = await fs.stat(canonical);
      return stat.isDirectory()
        ? { available: true, effectiveProjectKey: canonical }
        : { available: false, effectiveProjectKey: null };
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (
        isProjectBoundaryError(error) ||
        code === 'ENOENT' ||
        code === 'ENOTDIR' ||
        code === 'EACCES' ||
        code === 'EPERM' ||
        code === 'ELOOP'
      ) {
        return { available: false, effectiveProjectKey: null };
      }
      throw error;
    }
  }
}
