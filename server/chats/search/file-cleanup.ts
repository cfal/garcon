import { promises as fs } from 'fs';
import path from 'path';
import { hasNodeErrorCode } from '../../lib/errors.js';

export const TRANSCRIPT_SEARCH_DATABASE_NAMES = [
  'chat-search.sqlite',
  'chat-search-v3.sqlite',
] as const;

export function transcriptSearchDatabasePath(workspaceDir: string): string {
  return path.join(workspaceDir, 'chat-search-v3.sqlite');
}

export function transcriptSearchScratchDirectory(workspaceDir: string): string {
  return path.join(workspaceDir, '.chat-search-v3-tmp');
}

export function transcriptSearchFileCandidates(workspaceDir: string): string[] {
  return [
    ...TRANSCRIPT_SEARCH_DATABASE_NAMES.flatMap((name) => {
      const dbPath = path.join(workspaceDir, name);
      return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    }),
    transcriptSearchScratchDirectory(workspaceDir),
  ];
}

export async function deleteTranscriptSearchFiles(workspaceDir: string): Promise<void> {
  const delays = [0, 25, 75, 200, 500];
  const scratchDirectory = transcriptSearchScratchDirectory(workspaceDir);
  let lastFailure: { filePath: string; error: unknown } | null = null;
  for (const delay of delays) {
    if (delay > 0) await Bun.sleep(delay);
    lastFailure = null;
    for (const filePath of transcriptSearchFileCandidates(workspaceDir)) {
      try {
        await fs.rm(filePath, { recursive: filePath === scratchDirectory, force: true });
      } catch (error) {
        lastFailure = { filePath, error };
        if (!hasNodeErrorCode(error, 'EBUSY') && !hasNodeErrorCode(error, 'EPERM')) {
          throw new Error(`Failed to delete transcript search file ${filePath}: ${String(error)}`);
        }
      }
    }
    if (!lastFailure) return;
  }
  throw new Error(
    `Failed to delete transcript search file ${lastFailure?.filePath ?? workspaceDir}: ${String(lastFailure?.error)}`,
  );
}
