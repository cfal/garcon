import { createGitOperations } from '../git-service.js';
import { gitHttpError } from '../../../controller/git/http-error.js';
import { generateCommitMessageForFiles } from '../../../controller/git/commit-generation.js';
import type { ClassifiedGitError } from '../types.js';
import type { CommitMessageFileOptions, GitAgentRunner } from '../../../controller/git/commit-generation-types.js';

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
