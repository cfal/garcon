import { literalGitPathspec } from './pathspecs.js';
import { readOnlyGitOptions, runGit } from './run.js';
import { createTemporaryGitIndex, removeTemporaryGitIndex } from './temporary-index.js';
import type { GitCommandOptions } from './types.js';

export async function loadUntrackedPatch(
  projectPath: string,
  file: string,
  contextLines: number,
  options: GitCommandOptions = {},
): Promise<string> {
  const temporaryIndex = await createTemporaryGitIndex(projectPath, options.signal);
  try {
    // Indexed attributes participate in clean conversion without changing the real index.
    const scratchOptions = readOnlyGitOptions({
      ...options,
      env: { ...options.env, GIT_INDEX_FILE: temporaryIndex },
    });
    const pathspec = literalGitPathspec(file);
    await runGit(projectPath, ['add', '-N', '--', pathspec], scratchOptions);
    const { stdout } = await runGit(projectPath, [
      'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
      `-U${contextLines}`, '--', pathspec,
    ], scratchOptions);
    return stdout;
  } finally {
    await removeTemporaryGitIndex(temporaryIndex);
  }
}
