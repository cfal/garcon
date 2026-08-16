import { promises as fs } from 'node:fs';
import path from 'node:path';

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface DirectLegacySessionPaths {
  findSessionFilePath(sessionId: string): Promise<string | null>;
}

export function createDirectLegacySessionPaths(
  agentStorageRoot: string,
  storageNamespace: string,
): DirectLegacySessionPaths {
  const root = path.resolve(
    agentStorageRoot,
    requireSafePathSegment(storageNamespace, 'storage namespace'),
  );

  return {
    async findSessionFilePath(sessionId) {
      const safeSessionId = requireSafePathSegment(sessionId, 'session ID');
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (error) {
        if (hasNodeErrorCode(error, 'ENOENT')) return null;
        throw error;
      }

      const endpointIds = entries
        .filter((entry) => entry.isDirectory() && isSafePathSegment(entry.name))
        .map((entry) => entry.name)
        .sort();
      let match: string | null = null;
      for (const endpointId of endpointIds) {
        const candidate = path.join(root, endpointId, `${safeSessionId}.jsonl`);
        let stats: Awaited<ReturnType<typeof fs.lstat>>;
        try {
          stats = await fs.lstat(candidate);
        } catch (error) {
          if (hasNodeErrorCode(error, 'ENOENT')) continue;
          throw error;
        }
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw new Error('Direct legacy transcript source is not a regular file');
        }
        if (match) throw new Error('Direct legacy transcript session ID is ambiguous');
        match = candidate;
      }
      return match;
    },
  };
}

function isSafePathSegment(value: string): boolean {
  return SAFE_PATH_SEGMENT.test(value) && value !== '.' && value !== '..';
}

function requireSafePathSegment(value: string, label: string): string {
  if (!isSafePathSegment(value)) throw new Error(`Invalid Direct ${label}`);
  return value;
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
