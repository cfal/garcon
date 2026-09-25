import { promises as fs } from 'fs';
import path from 'path';
import { hasNodeErrorCode } from '../../common/errors.js';
import { createLogger } from '../../common/log.js';
import { readOnlyGitOptions, runGit } from './run.js';

const logger = createLogger('git:temporary-index');
const TEMPORARY_INDEX_PREFIX = '.garcon-index-';
const STALE_TEMPORARY_INDEX_AGE_MS = 24 * 60 * 60 * 1000;

async function removeFilesBestEffort(filePaths: string[]): Promise<void> {
  const results = await Promise.allSettled(
    filePaths.map((filePath) => fs.rm(filePath, { force: true })),
  );
  for (const result of results) {
    if (result.status === 'rejected') logger.warn('Failed to remove temporary Git index');
  }
}

async function removeStaleTemporaryGitIndexes(indexDirectory: string): Promise<void> {
  try {
    const entries = await fs.readdir(indexDirectory, { withFileTypes: true });
    const cutoff = Date.now() - STALE_TEMPORARY_INDEX_AGE_MS;
    const stalePaths: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(TEMPORARY_INDEX_PREFIX)) continue;
      const entryPath = path.join(indexDirectory, entry.name);
      const stats = await fs.stat(entryPath);
      if (stats.mtimeMs < cutoff) stalePaths.push(entryPath);
    }
    await removeFilesBestEffort(stalePaths);
  } catch {
    logger.warn('Failed to sweep stale temporary Git indexes');
  }
}

export async function createTemporaryGitIndex(projectPath: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await runGit(
    projectPath,
    ['rev-parse', '--git-path', 'index'],
    readOnlyGitOptions({ signal }),
  );
  const indexPath = path.resolve(projectPath, stdout.trim());
  const indexDirectory = path.dirname(indexPath);
  await removeStaleTemporaryGitIndexes(indexDirectory);
  const temporaryIndexPath = path.join(
    indexDirectory,
    `${TEMPORARY_INDEX_PREFIX}${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    await fs.copyFile(indexPath, temporaryIndexPath);
  } catch (error) {
    if (!hasNodeErrorCode(error, 'ENOENT')) {
      await removeTemporaryGitIndex(temporaryIndexPath);
      throw error;
    }
  }
  return temporaryIndexPath;
}

export async function removeTemporaryGitIndex(temporaryIndexPath: string): Promise<void> {
  await removeFilesBestEffort([temporaryIndexPath, `${temporaryIndexPath}.lock`]);
}
