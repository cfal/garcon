import { promises as fs } from 'fs';
import path from 'path';
import { hasNodeErrorCode } from '../lib/errors.js';
import { createLogger } from '../lib/log.js';
import { literalGitPathspec } from './pathspecs.js';
import { readOnlyGitOptions, runGit, runGitWithStdin } from './run.js';

const logger = createLogger('git:selected-file-commit');
const TEMPORARY_INDEX_PREFIX = '.garcon-index-';
const STALE_TEMPORARY_INDEX_AGE_MS = 24 * 60 * 60 * 1000;

async function removeFilesBestEffort(filePaths: string[]): Promise<void> {
  const results = await Promise.allSettled(
    filePaths.map((filePath) => fs.rm(filePath, { force: true })),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      logger.warn(`Failed to remove temporary Git index ${filePaths[index]}:`, result.reason);
    }
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
  } catch (error) {
    logger.warn('Failed to sweep stale temporary Git indexes:', error);
  }
}

async function createTemporaryGitIndex(projectPath: string): Promise<string> {
  const { stdout } = await runGit(
    projectPath,
    ['rev-parse', '--git-path', 'index'],
    readOnlyGitOptions(),
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
    if (!hasNodeErrorCode(error, 'ENOENT')) throw error;
  }
  return temporaryIndexPath;
}

async function removeTemporaryGitIndex(temporaryIndexPath: string): Promise<void> {
  await removeFilesBestEffort([temporaryIndexPath, `${temporaryIndexPath}.lock`]);
}

function encodePathspecs(pathspecs: string[]): string {
  return `${pathspecs.join('\0')}\0`;
}

async function synchronizeCommittedPaths(
  projectPath: string,
  pathspecInput: string,
): Promise<void> {
  try {
    await runGitWithStdin(
      projectPath,
      ['reset', '--quiet', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'],
      pathspecInput,
    );
  } catch (error) {
    // The ref already moved, so index synchronization cannot change commit success.
    logger.warn('Selected-file commit succeeded but the real index could not be synchronized:', error);
  }
}

export async function commitSelectedFiles(
  projectPath: string,
  message: string,
  files: string[],
): Promise<string> {
  const pathspecs = files.map(literalGitPathspec);
  const pathspecInput = encodePathspecs(pathspecs);
  const temporaryIndexPath = await createTemporaryGitIndex(projectPath);
  // Post-commit hooks inherit this isolated index; their index writes are discarded.
  const temporaryIndexOptions = { env: { GIT_INDEX_FILE: temporaryIndexPath } };
  try {
    await runGitWithStdin(
      projectPath,
      ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
      pathspecInput,
      temporaryIndexOptions,
    );
    const { stdout } = await runGitWithStdin(
      projectPath,
      [
        'commit',
        '--only',
        '-m',
        message,
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      pathspecInput,
      temporaryIndexOptions,
    );
    await synchronizeCommittedPaths(projectPath, pathspecInput);
    return stdout;
  } finally {
    await removeTemporaryGitIndex(temporaryIndexPath);
  }
}
