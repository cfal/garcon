import type { ExecutionNode, NodeCallOptions } from '@garcon/server-agent-interface';
import { GIT_OPERATION_TIMEOUT_MS, GH_DETAIL_TIMEOUT_MS, type GitNodeScope } from '../../common/git-execution.js';
import { isGitMethod, validateGitRequest } from '../../common/git-request-validation.js';
import type { GitMethod } from '../../common/git.js';
import type { ExecutionGitRequests } from '../../common/git-execution.js';
import { GitServiceError } from '../../common/git-error.js';
import { isRecord } from '../../common/json.js';
import type { GitRpcRequest } from './git-protocol.js';
import { validateGitResult, validateGhResult } from '../../common/git-result-validation.js';

export class GitWorker {
  constructor(private readonly node: ExecutionNode, private readonly scope: GitNodeScope) {}

  async handle(call: GitRpcRequest, signal: AbortSignal): Promise<unknown> {
    const maximum = call.method === 'gh.getPullRequest' ? GH_DETAIL_TIMEOUT_MS : GIT_OPERATION_TIMEOUT_MS;
    if (!isRecord(call.request) || Object.keys(call.request).some(k => k !== 'input' && k !== 'budgetMs')
      || !isRecord(call.request.input) || !Number.isSafeInteger(call.request.budgetMs)
      || call.request.budgetMs <= 0 || call.request.budgetMs > maximum) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid Git operation deadline');
    const { input, budgetMs } = call.request;
    const options = { signal, timeoutMs: budgetMs };
    switch (call.method) {
      case 'gh.getStatus': case 'gh.listPullRequests': case 'gh.getPullRequest': {
        const gh = await this.node.getGhService(options);
        const expected = call.method === 'gh.getStatus' ? [] : call.method === 'gh.listPullRequests' ? ['projectPath'] : ['projectPath', 'number'];
        if (Object.keys(input).some(k => !expected.includes(k))) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid GitHub request');
        const result = call.method === 'gh.getStatus' ? await gh.getStatus(options)
          : call.method === 'gh.listPullRequests' ? await gh.listPullRequests(call.request.input, options)
          : await gh.getPullRequest(call.request.input, options);
        validateGhResult(call.method.slice(3) as 'getStatus' | 'listPullRequests' | 'getPullRequest', result, this.scope);
        return result;
      }
    }
    const method = call.method.slice(4);
    if (!isGitMethod(method)) throw new GitServiceError('GIT_INVALID_INPUT', 'Unsupported Git operation');
    validateGitRequest(method, input);
    const service = await this.node.getGitService(options);
    const invoke = service[method] as (request: ExecutionGitRequests[GitMethod], options: NodeCallOptions) => Promise<unknown>;
    const result = await invoke(input, options);
    validateGitResult(method, result, this.scope);
    return result;
  }
}
