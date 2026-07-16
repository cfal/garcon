import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

export interface SearchTranscriptScratch {
  db: Database;
  close(): Promise<void>;
}

export async function createSearchTranscriptScratch(
  scratchDirectory: string,
  prefix: string,
): Promise<SearchTranscriptScratch> {
  await mkdir(scratchDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(scratchDirectory, prefix));
  let db: Database | null = null;
  try {
    db = new Database(path.join(directory, 'transcript.sqlite'));
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = FILE');
  } catch (error) {
    try {
      db?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
  let closed = false;
  return {
    db,
    async close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
