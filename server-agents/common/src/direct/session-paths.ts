import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface DirectSessionPaths {
  sessionDir(endpointId: string): string;
  sessionFilePath(endpointId: string, sessionId: string): string;
  findSessionFilePath(
    sessionId: string,
    preferredEndpointId?: string | null,
  ): Promise<string | null>;
}

export function isSafeDirectPathSegment(value: unknown): value is string {
  return typeof value === 'string'
    && SAFE_PATH_SEGMENT_RE.test(value)
    && value !== '.'
    && value !== '..';
}

function requireSafePathSegment(value: string, label: string): string {
  if (!isSafeDirectPathSegment(value)) {
    throw new Error(`Invalid Direct ${label}: ${value}`);
  }
  return value;
}

export function createDirectSessionPaths(
  workspaceDir: string,
  storageNamespace: string,
): DirectSessionPaths {
  const root = path.resolve(workspaceDir, requireSafePathSegment(
    storageNamespace,
    'storage namespace',
  ));

  return {
    sessionDir(endpointId) {
      return path.join(root, requireSafePathSegment(endpointId, 'endpoint ID'));
    },
    sessionFilePath(endpointId, sessionId) {
      return path.join(
        root,
        requireSafePathSegment(endpointId, 'endpoint ID'),
        `${requireSafePathSegment(sessionId, 'session ID')}.jsonl`,
      );
    },
    async findSessionFilePath(sessionId, preferredEndpointId) {
      const safeSessionId = requireSafePathSegment(sessionId, 'session ID');
      if (preferredEndpointId) {
        const preferred = path.join(
          root,
          requireSafePathSegment(preferredEndpointId, 'endpoint ID'),
          `${safeSessionId}.jsonl`,
        );
        if (await pathExists(preferred)) return preferred;
      }

      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (error: unknown) {
        if (hasNodeErrorCode(error, 'ENOENT')) return null;
        throw error;
      }
      const endpointIds = entries
        .filter((entry) => entry.isDirectory() && isSafeDirectPathSegment(entry.name))
        .map((entry) => entry.name)
        .sort();
      for (const endpointId of endpointIds) {
        if (endpointId === preferredEndpointId) continue;
        const candidate = path.join(root, endpointId, `${safeSessionId}.jsonl`);
        if (await pathExists(candidate)) return candidate;
      }
      return null;
    },
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, constants.F_OK);
    return true;
  } catch (error: unknown) {
    if (hasNodeErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
