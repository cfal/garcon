import { promises as fs } from 'fs';
import path from 'path';
import { hasNodeErrorCode } from '../lib/errors.js';
import { literalGitPathspec } from './pathspecs.js';
import { readOnlyGitOptions, runGit } from './run.js';

async function createTemporaryGitIndex(projectPath: string): Promise<string> {
  const { stdout } = await runGit(
    projectPath,
    ['rev-parse', '--git-path', 'index'],
    readOnlyGitOptions(),
  );
  const indexPath = path.resolve(projectPath, stdout.trim());
  const temporaryIndexPath = path.join(
    path.dirname(indexPath),
    `.garcon-index-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    await fs.copyFile(indexPath, temporaryIndexPath);
  } catch (error) {
    if (!hasNodeErrorCode(error, 'ENOENT')) throw error;
  }
  return temporaryIndexPath;
}

async function removeTemporaryGitIndex(temporaryIndexPath: string): Promise<void> {
  await Promise.all([
    fs.rm(temporaryIndexPath, { force: true }),
    fs.rm(`${temporaryIndexPath}.lock`, { force: true }),
  ]);
}

export async function commitSelectedFiles(
  projectPath: string,
  message: string,
  files: string[],
): Promise<string> {
  const pathspecs = files.map(literalGitPathspec);
  const temporaryIndexPath = await createTemporaryGitIndex(projectPath);
  const temporaryIndexOptions = { env: { GIT_INDEX_FILE: temporaryIndexPath } };
  try {
    for (const pathspec of pathspecs) {
      await runGit(projectPath, ['add', '--', pathspec], temporaryIndexOptions);
    }
    const { stdout } = await runGit(
      projectPath,
      ['commit', '--only', '-m', message, '--', ...pathspecs],
      temporaryIndexOptions,
    );
    // Partial commits restore their source index after hooks, so align committed paths explicitly.
    await runGit(projectPath, ['reset', '--quiet', 'HEAD', '--', ...pathspecs]);
    return stdout;
  } finally {
    await removeTemporaryGitIndex(temporaryIndexPath);
  }
}
