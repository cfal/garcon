import { exactGitPathspecs } from './pathspecs.js';
import { readOnlyGitOptions, runGitTraced } from './run.js';
import { createTemporaryGitIndex, removeTemporaryGitIndex } from './temporary-index.js';
import type { GitCommandOptions, GitCommandTrace } from './types.js';

export async function loadUntrackedPatches(
  projectPath: string,
  files: string[],
  contextLines: number,
  options: GitCommandOptions = {},
  trace?: GitCommandTrace[],
): Promise<string> {
  const temporaryIndex = await createTemporaryGitIndex(projectPath, options.signal);
  try {
    // Indexed attributes participate in clean conversion without changing the real index.
    const scratchOptions = readOnlyGitOptions({
      ...options,
      env: { ...options.env, GIT_INDEX_FILE: temporaryIndex },
    });
    const pathspecs = exactGitPathspecs(files);
    await runGitTraced(projectPath, ['add', '-N', '--', ...pathspecs], trace, scratchOptions);
    const { stdout } = await runGitTraced(projectPath, [
      'diff', '--patch-with-raw', '-z', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
      `-U${contextLines}`, '--', ...pathspecs,
    ], trace, scratchOptions);
    return stdout;
  } finally {
    await removeTemporaryGitIndex(temporaryIndex);
  }
}
