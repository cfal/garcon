import { createGitOperations, gitHttpError } from '../git-service.js';
import { generateCommitMessageForFiles } from '../commit-generation.js';
import type { ClassifiedGitError, CommitMessageFileOptions, GitAgentRunner } from '../types.js';

export function createGitService({ agents, classifyGitError, assertProjectPathAllowed }: {
  agents: GitAgentRunner;
  classifyGitError(error: unknown): ClassifiedGitError;
  assertProjectPathAllowed?(projectPath: string): Promise<string>;
}) {
  const git = createGitOperations({ assertProjectPathAllowed });
  return {
    ...git,
    generateCommitMessageForFiles: (options: CommitMessageFileOptions) => generateCommitMessageForFiles(agents, {
      collectCommitMessageContext: (request, callOptions) => git.collectCommitMessageContext({ ...request, signal: callOptions?.signal }),
    }, options),
    toHttpError: (error: unknown) => gitHttpError(error, classifyGitError),
  };
}
