import { literalGitPathspec } from './pathspecs.js';
import { readOnlyGitOptions, runGit } from './run.js';
import { createTemporaryGitIndex, removeTemporaryGitIndex } from './temporary-index.js';
import type { GitCommandOptions } from './types.js';

export async function untrackedPatch(projectPath: string, file: string, context: number, options: GitCommandOptions = {}): Promise<string> {
  const temporaryIndex = await createTemporaryGitIndex(projectPath, options.signal);
  try {
    // Indexed attributes participate in clean conversion without changing the real index.
    const scratchOptions = readOnlyGitOptions({ ...options, env: { ...options.env, GIT_INDEX_FILE: temporaryIndex } });
    await runGit(projectPath, ['add', '-N', '--', literalGitPathspec(file)], scratchOptions);
    const { stdout } = await runGit(projectPath, [
      'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
      `-U${context}`, '--', literalGitPathspec(file),
    ], scratchOptions);
    return stdout;
  } finally {
    await removeTemporaryGitIndex(temporaryIndex);
  }
}
