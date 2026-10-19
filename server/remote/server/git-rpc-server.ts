import type { ExecutionRuntimeApi, ExecutorCallOptions } from '@garcon/server-agent-interface';
import { GIT_OPERATION_TIMEOUT_MS, ghOperationTimeoutMs } from '../../../common/git-execution.js';
import { isGhMethod, isGitMethod, validateGhRequest, validateGitRequest } from '../../../common/git-request-validation.js';
import type { GhRequests } from '../../../common/gh.js';
import type { GitMethod } from '../../../common/git.js';
import type { ExecutionGitRequests } from '../../../common/git-execution.js';
import { GitServiceError } from '../../../common/git-error.js';
import { isRecord } from '../../../common/json.js';
import type { GitRpcRequest } from '../transport/git-protocol.js';

export class GitRpcServer {
  constructor(private readonly executor: ExecutionRuntimeApi) {}

  async handle(call: GitRpcRequest, signal: AbortSignal): Promise<unknown> {
    const ghMethod = call.method.startsWith('gh.') ? call.method.slice(3) : null;
    const maximum = ghMethod && isGhMethod(ghMethod) ? ghOperationTimeoutMs(ghMethod) : GIT_OPERATION_TIMEOUT_MS;
    if (!isRecord(call.request) || Object.keys(call.request).some(k => k !== 'input' && k !== 'budgetMs')
      || !isRecord(call.request.input) || !Number.isSafeInteger(call.request.budgetMs)
      || call.request.budgetMs <= 0 || call.request.budgetMs > maximum) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid Git operation deadline');
    const { input, budgetMs } = call.request;
    const options = { signal, timeoutMs: budgetMs };
    if (call.method.startsWith('gh.')) {
      const ghMethod = call.method.slice(3);
      if (!isGhMethod(ghMethod)) throw new GitServiceError('GIT_INVALID_INPUT', 'Unsupported GitHub operation');
      return this.#gh(ghMethod, input, options);
    }
    const method = call.method.slice(4);
    if (!isGitMethod(method)) throw new GitServiceError('GIT_INVALID_INPUT', 'Unsupported Git operation');
    validateGitRequest(method, input);
    const service = await this.executor.getGitService(options);
    const invoke = service[method] as (request: ExecutionGitRequests[GitMethod], options: ExecutorCallOptions) => Promise<unknown>;
    return invoke(input, options);
  }

  async #gh(method: keyof GhRequests, input: unknown, options: ExecutorCallOptions): Promise<unknown> {
    const gh = await this.executor.getGhService(options);
    switch (method) {
      case 'getStatus': validateGhRequest(method, input); return gh.getStatus(options);
      case 'listPullRequests': validateGhRequest(method, input); return gh.listPullRequests(input, options);
      case 'getPullRequest': validateGhRequest(method, input); return gh.getPullRequest(input, options);
      case 'getPullRequestReviewTarget': validateGhRequest(method, input); return gh.getPullRequestReviewTarget(input, options);
      case 'createPullRequestComment': validateGhRequest(method, input); return gh.createPullRequestComment(input, options);
      case 'minimizePullRequestComment': validateGhRequest(method, input); return gh.minimizePullRequestComment(input, options);
    }
  }
}
