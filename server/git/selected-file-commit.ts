import { createLogger } from '../lib/log.js';
import { literalGitPathspec } from './pathspecs.js';
import { readOnlyGitOptions, runGit, runGitWithStdin } from './run.js';
import { createTemporaryGitIndex, removeTemporaryGitIndex } from './temporary-index.js';

const logger = createLogger('git:selected-file-commit');

function encodePathspecs(pathspecs: string[]): string {
  return `${pathspecs.join('\0')}\0`;
}

function topLevelLiteralGitPathspec(filePath: string): string {
  return `:(top,literal)${filePath}`;
}

async function readCommittedPathspecs(projectPath: string): Promise<string[] | null> {
  try {
    const { stdout } = await runGit(
      projectPath,
      ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', '--root', 'HEAD', '--'],
      readOnlyGitOptions(),
    );
    return stdout
      .split('\0')
      .filter(Boolean)
      .map(topLevelLiteralGitPathspec);
  } catch {
    logger.warn('Selected-file commit succeeded but its committed paths could not be inspected');
    return null;
  }
}

async function synchronizeCommittedPaths(
  projectPath: string,
  pathspecInput: string,
): Promise<boolean> {
  try {
    await runGitWithStdin(
      projectPath,
      ['reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul', 'HEAD', '--'],
      pathspecInput,
    );
    return true;
  } catch {
    // The ref already moved, so index synchronization cannot change commit success.
    logger.warn('Selected-file commit succeeded but the real index could not be synchronized');
    return false;
  }
}

interface SelectedFileCommitResult {
  output: string;
  indexSynchronized: boolean;
}

export async function commitSelectedFiles(
  projectPath: string,
  message: string,
  files: string[],
): Promise<SelectedFileCommitResult> {
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
    const committedPathspecs = await readCommittedPathspecs(projectPath);
    const synchronizationPathspecs = committedPathspecs
      ? Array.from(new Set([...pathspecs, ...committedPathspecs]))
      : pathspecs;
    const requestedPathsSynchronized = await synchronizeCommittedPaths(
      projectPath,
      encodePathspecs(synchronizationPathspecs),
    );
    const indexSynchronized = committedPathspecs !== null && requestedPathsSynchronized;
    return { output: stdout, indexSynchronized };
  } finally {
    await removeTemporaryGitIndex(temporaryIndexPath);
  }
}
