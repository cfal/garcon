import { GitDomainError } from './git-types.js';
import {
  COMMIT_MESSAGE_ERROR_MAP,
  isCommitMessageErrorCode,
} from './commit-message.js';
import { createDiffEngine } from './diff-engine.js';
import { createPorcelainOperations } from './porcelain.js';
import { createStatusOperations } from './status.js';
import { createWorktreeOperations } from './worktrees.js';
import type { ClassifiedGitError, CreateGitServiceOptions, GitService } from './types.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('git:git-service');

export type { GitService } from './types.js';

function gitDomainErrorToResponse(error: GitDomainError): Response {
  const code = error.code;
  if (isCommitMessageErrorCode(code)) {
    const entry = COMMIT_MESSAGE_ERROR_MAP[code];
    return Response.json(
      { error: error.message, errorCode: entry.errorCode },
      { status: entry.status },
    );
  }
  if (code === 'INVALID_INPUT') return Response.json({ error: error.message }, { status: 400 });
  if (code === 'NOT_REPO') return Response.json({ error: error.message }, { status: 400 });
  if (code === 'AUTH_FAILED') return Response.json({ error: error.message }, { status: 401 });
  return Response.json({ error: error.message }, { status: 500 });
}

function classifiedGitErrorToResponse(classified: ClassifiedGitError): Response {
  const body: { error: string; details?: unknown } = { error: classified.message };
  if (classified.details) body.details = classified.details;
  return Response.json(body, { status: classified.status });
}

export function createGitService({ agents, classifyGitError }: CreateGitServiceOptions): GitService {
  const status = createStatusOperations(agents);
  const diff = createDiffEngine();
  const porcelain = createPorcelainOperations();
  const worktrees = createWorktreeOperations();

  return {
    ...status,
    ...diff,
    ...porcelain,
    ...worktrees,
    toHttpError(error: unknown): Response {
      logger.error('[git]', error);
      if (error instanceof GitDomainError) {
        return gitDomainErrorToResponse(error);
      }
      return classifiedGitErrorToResponse(classifyGitError(error));
    },
  };
}
