import { promises as fs } from 'fs';
import path from 'path';

export const TRANSCRIPT_SEARCH_DATABASE_NAMES = [
  'chat-search.sqlite',
  'chat-search-v3.sqlite',
] as const;

export function transcriptSearchDatabasePath(workspaceDir: string): string {
  return path.join(workspaceDir, 'chat-search-v3.sqlite');
}

export function transcriptSearchFileCandidates(workspaceDir: string): string[] {
  return TRANSCRIPT_SEARCH_DATABASE_NAMES.flatMap((name) => {
    const dbPath = path.join(workspaceDir, name);
    return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  });
}

export async function deleteTranscriptSearchFiles(workspaceDir: string): Promise<void> {
  const failures: Array<{ filePath: string; error: unknown }> = [];
  for (const filePath of transcriptSearchFileCandidates(workspaceDir)) {
    try {
      await fs.rm(filePath, { force: true });
    } catch (error) {
      failures.push({ filePath, error });
    }
  }
  if (failures.length > 0) {
    const first = failures[0];
    throw new Error(`Failed to delete transcript search file ${first.filePath}: ${String(first.error)}`);
  }
}

