import type { ExecutionRuntimeApi, ExecutorCallOptions } from '@garcon/server-agent-interface';
import { GIT_OPERATION_TIMEOUT_MS, GH_DETAIL_TIMEOUT_MS } from '../../../common/git-execution.js';
import { isGitMethod, validateGitRequest } from '../../../common/git-request-validation.js';
import type { GitMethod } from '../../../common/git.js';
import type { ExecutionGitRequests } from '../../../common/git-execution.js';
import { GitServiceError } from '../../../common/git-error.js';
import { isRecord } from '../../../common/json.js';
import type { GitRpcRequest } from '../transport/git-protocol.js';

const GH_REQUEST_FIELDS = {
  'gh.getStatus': [],
  'gh.listPullRequests': ['projectPath'],
  'gh.getPullRequest': ['projectPath', 'number'],
};

export class GitRpcServer {
  constructor(private readonly executor: ExecutionRuntimeApi) {}

  async handle(call: GitRpcRequest, signal: AbortSignal): Promise<unknown> {
    const maximum = call.method === 'gh.getPullRequest' ? GH_DETAIL_TIMEOUT_MS : GIT_OPERATION_TIMEOUT_MS;
    if (!isRecord(call.request) || Object.keys(call.request).some(k => k !== 'input' && k !== 'budgetMs')
      || !isRecord(call.request.input) || !Number.isSafeInteger(call.request.budgetMs)
      || call.request.budgetMs <= 0 || call.request.budgetMs > maximum) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid Git operation deadline');
    const { input, budgetMs } = call.request;
    const options = { signal, timeoutMs: budgetMs };
    switch (call.method) {
      case 'gh.getStatus': case 'gh.listPullRequests': case 'gh.getPullRequest': {
        const gh = await this.executor.getGhService(options);
        const expected: readonly string[] = GH_REQUEST_FIELDS[call.method];
        if (Object.keys(input).some(k => !expected.includes(k))) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid GitHub request');
        switch (call.method) {
          case 'gh.getStatus':
            return await gh.getStatus(options);
          case 'gh.listPullRequests':
            return await gh.listPullRequests(call.request.input, options);
          case 'gh.getPullRequest':
            return await gh.getPullRequest(call.request.input, options);
        }
      }
    }
    const method = call.method.slice(4);
    if (!isGitMethod(method)) throw new GitServiceError('GIT_INVALID_INPUT', 'Unsupported Git operation');
    validateGitRequest(method, input);
    const service = await this.executor.getGitService(options);
    const invoke = service[method] as (request: ExecutionGitRequests[GitMethod], options: ExecutorCallOptions) => Promise<unknown>;
    return invoke(input, options);
  }
}
