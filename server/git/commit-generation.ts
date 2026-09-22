import { GitDomainError } from './git-types.js';
import { generateCommitMessage } from './commit-message.js';
import { createGenerationRequestSignal } from '../settings/generation-limits.js';
import { applyDirPrefix, computeCommonDirPrefix } from './commit-prefix.js';
import type { CommitMessageFileOptions, CommitMessageGenerationResult, GitAgentRunner, GitOperations } from './types.js';

export async function generateCommitMessageForFiles(
  agents: GitAgentRunner,
  git: Pick<GitOperations, 'collectCommitMessageContext'>,
  request: CommitMessageFileOptions,
): Promise<CommitMessageGenerationResult> {
  const { projectPath, files, agentId, useCommonDirPrefix, ...options } = request;
  if (!Array.isArray(files) || files.length === 0) {
    throw new GitDomainError('COMMIT_MESSAGE_NO_STAGED_FILES', 'No staged files to generate a commit message.');
  }
  const signal = options.signal ?? createGenerationRequestSignal();
  const { diff } = await git.collectCommitMessageContext({ projectPath, files, signal });
  if (!diff.trim()) {
    throw new GitDomainError('COMMIT_MESSAGE_NO_STAGED_FILES', 'No staged changes found for selected files.');
  }
  const message = await generateCommitMessage(
    files, diff, agentId, (prompt, selection) => agents.runSingleQuery(prompt, selection), { ...options, signal },
  );
  const directoryPrefix = useCommonDirPrefix ? computeCommonDirPrefix(files) : '';
  return { message: directoryPrefix ? applyDirPrefix(message, directoryPrefix) : message, directoryPrefix };
}
