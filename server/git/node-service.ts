import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { ExecutionGitService, ExecutionGhService, NodeCallOptions } from '@garcon/server-agent-interface';
import { AgentCallError } from '@garcon/server-agent-interface';
import type { GitMethod, GitRequests, GitResults } from '../../common/git.js';
import { isGitMutation, type ExecutionGitRequests, type GitNodeScope } from '../../common/git-execution.js';
import { GitServiceError } from '../../common/git-error.js';
import { validateGitRequest, validateGhRequest } from '../../common/git-request-validation.js';
import { validateGitResult, validateGhResult } from '../../common/git-result-validation.js';
import { isRecord } from '../../common/json.js';
import { assertRealWithinBase, resolveRealWithinBase } from '../lib/path-boundary.js';
import { toNativePath, toNodePath } from '../execution-nodes/node-path.js';
import { createGitOperations } from './git-service.js';
import { createGhOperations } from '../gh/gh-service.js';
import { withGitOperation, gitOutputTruncated, restrictGitWorkingRoot } from './operation-context.js';
import { withRepositoryMutation } from './repository-coordination.js';
import { readOnlyGitOptions, runGit } from './run.js';
import { classifyGitError } from './git-error-classifier.js';
import { gitServiceError } from './service-errors.js';
import type { GitStageProvenance } from './types.js';
import type { GitReviewDocumentRegistry } from './review-document-registry.js';

interface GitNodeOptions extends GitNodeScope {
  reviewRegistry?: GitReviewDocumentRegistry;
  projectBasePath: string;
  assertAvailable(options?: NodeCallOptions): void;
}

const processAdmission = { reads: 0, mutations: 0 };

export class LocalGitRuntime {
  readonly git: ExecutionGitService;
  readonly gh: ExecutionGhService;
  readonly #abort = new AbortController();
  readonly #operations;
  readonly #gh;
  #reads = 0;
  #mutations = 0;

  constructor(private readonly configuration: GitNodeOptions) {
    this.#operations = createGitOperations({ assertProjectPathAllowed: (input) => this.#path(input), reviewRegistry: configuration.reviewRegistry });
    this.#gh = createGhOperations(toNativePath(configuration.projectBasePath));
    this.git = this.#gitService();
    this.gh = {
      getStatus: (options) => this.#ghCall('getStatus', {}, options),
      listPullRequests: (request, options) => this.#ghCall('listPullRequests', request, options),
      getPullRequest: (request, options) => this.#ghCall('getPullRequest', request, options),
    };
  }

  dispose(): void { this.#abort.abort(); }

  async #path(input: string): Promise<string> {
    return assertRealWithinBase(toNativePath(this.configuration.projectBasePath), toNativePath(input));
  }

  #available(options?: NodeCallOptions): void {
    options?.signal?.throwIfAborted();
    if (this.#abort.signal.aborted) throw new AgentCallError('not-dispatched', 'Git serving instance retired');
    this.configuration.assertAvailable(options);
  }

  async #repository(projectPath: string, options?: NodeCallOptions): Promise<string> {
    this.#available(options);
    const project = await this.#path(projectPath);
    if (!(await stat(project)).isDirectory()) throw new GitServiceError('GIT_INVALID_INPUT', 'Git project must be a directory');
    restrictGitWorkingRoot(project);
    try {
      const { stdout } = await runGit(project, ['rev-parse', '--show-toplevel'], readOnlyGitOptions({ signal: options?.signal }));
      restrictGitWorkingRoot(await this.#path(stdout.replace(/\r?\n$/, '')));
    } catch (error) {
      if (classifyGitError(error).code !== 'NOT_REPO') throw error;
    }
    return project;
  }

  async #admit<T>(mutation: boolean, options: NodeCallOptions | undefined, operation: (options: NodeCallOptions) => Promise<T>): Promise<T> {
    this.#available(options);
    if (mutation ? this.#mutations >= 8 || processAdmission.mutations >= 16 : this.#reads >= 2 || processAdmission.reads >= 4) throw new GitServiceError('GIT_SERVICE_BUSY', 'Git operation capacity is exhausted');
    if (mutation) { this.#mutations++; processAdmission.mutations++; } else { this.#reads++; processAdmission.reads++; }
    const signal = options?.signal ? AbortSignal.any([options.signal, this.#abort.signal]) : this.#abort.signal;
    try {
      const callOptions = { ...options, signal };
      return await withGitOperation(toNativePath(this.configuration.projectBasePath), { ...callOptions, mutation }, (signal) => operation({ ...callOptions, signal }));
    } finally {
      if (mutation) { this.#mutations--; processAdmission.mutations--; } else { this.#reads--; processAdmission.reads--; }
    }
  }

  async #run<K extends GitMethod>(method: K, request: ExecutionGitRequests[K], options?: NodeCallOptions): Promise<GitResults[K] & GitNodeScope> {
    validateGitRequest(method, request);
    try {
      return await this.#admit(isGitMutation(method), options, async (callOptions) => {
        const projectPath = await this.#repository(request.projectPath, callOptions);
        const execute = async () => {
          this.#available(callOptions);
          if (await this.#repository(request.projectPath, callOptions) !== projectPath) throw new GitServiceError('GIT_INVALID_INPUT', 'Repository path changed');
          const input = { ...request, projectPath, signal: callOptions.signal };
          if ('document' in input) {
            if (input.document.nodeId !== this.configuration.nodeId || input.document.instanceId !== this.configuration.instanceId) throw new GitServiceError('GIT_STALE_DOCUMENT', 'Git review belongs to a different node or serving instance');
            Object.assign(input, { documentId: input.document.documentId });
          }
          if ('worktreePath' in input) input.worktreePath = await this.#path(path.resolve(projectPath, toNativePath(input.worktreePath)));
          const files = 'file' in input ? [input.file] : 'paths' in input ? input.paths : 'files' in input ? input.files : [];
          for (const file of files) await resolveRealWithinBase(projectPath, toNativePath(file));
          const invoke = this.#operations[method] as (input: GitRequests[GitMethod] & GitStageProvenance & { signal?: AbortSignal }) => Promise<GitResults[K]>;
          const result = await invoke(input);
          const response = { ...portableResult(result), nodeId: this.configuration.nodeId, instanceId: this.configuration.instanceId,
            ...(isGitMutation(method) && gitOutputTruncated() ? { outputTruncated: true } : {}) };
          try { validateGitResult(method, response, this.configuration); }
          catch (error) {
            if (isGitMutation(method)) throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Git mutation could not be confirmed. Inspect the repository before trying again.');
            throw error;
          }
          return response;
        };
        return isGitMutation(method) ? withRepositoryMutation(projectPath, execute) : execute();
      });
    } catch (error) { throw gitServiceError(error); }
  }

  async #ghCall<K extends keyof ExecutionGhService>(method: K, request: { projectPath?: string; number?: number }, options?: NodeCallOptions): Promise<Awaited<ReturnType<ExecutionGhService[K]>>> {
    validateGhRequest(method, request);
    try {
      const result = await this.#admit(false, options, async (callOptions) => {
        if (method === 'getStatus') return this.#gh.getStatus(callOptions.signal);
        if (typeof request.projectPath !== 'string' || !request.projectPath || request.projectPath.length > 4096 || request.projectPath.includes('\0')) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid GitHub project');
        const projectPath = await this.#repository(request.projectPath, callOptions);
        this.#available(callOptions);
        if (method === 'listPullRequests') return this.#gh.listPullRequests({ projectPath, signal: callOptions.signal });
        if (!Number.isSafeInteger(request.number) || request.number! <= 0) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid pull request number');
        return this.#gh.getPullRequest({ projectPath, number: request.number!, signal: callOptions.signal });
      }) as Awaited<ReturnType<ExecutionGhService[K]>>;
      validateGhResult(method, result);
      return result;
    } catch (error) { throw gitServiceError(error, 'gh'); }
  }

  #gitService(): ExecutionGitService {
    return {
      getStatus: (request, options) => this.#run('getStatus', request, options),
      initialCommit: (request, options) => this.#run('initialCommit', request, options),
      commit: (request, options) => this.#run('commit', request, options),
      getBranches: (request, options) => this.#run('getBranches', request, options),
      getRefs: (request, options) => this.#run('getRefs', request, options),
      checkout: (request, options) => this.#run('checkout', request, options),
      createBranch: (request, options) => this.#run('createBranch', request, options),
      getRemoteStatus: (request, options) => this.#run('getRemoteStatus', request, options),
      getRemotes: (request, options) => this.#run('getRemotes', request, options),
      fetch: (request, options) => this.#run('fetch', request, options),
      pull: (request, options) => this.#run('pull', request, options),
      push: (request, options) => this.#run('push', request, options),
      discard: (request, options) => this.#run('discard', request, options),
      deleteUntracked: (request, options) => this.#run('deleteUntracked', request, options),
      getWorkbenchSnapshot: (request, options) => this.#run('getWorkbenchSnapshot', request, options),
      getWorkingTreeFingerprint: (request, options) => this.#run('getWorkingTreeFingerprint', request, options),
      getQuickSummary: (request, options) => this.#run('getQuickSummary', request, options),
      getReviewDocumentFileBodies: (request, options) => this.#run('getReviewDocumentFileBodies', request, options),
      getHistoryCommits: (request, options) => this.#run('getHistoryCommits', request, options),
      getCommitSnapshot: (request, options) => this.#run('getCommitSnapshot', request, options),
      getComparisonSnapshot: (request, options) => this.#run('getComparisonSnapshot', request, options),
      getComparisonFreshness: (request, options) => this.#run('getComparisonFreshness', request, options),
      stageSelection: (request, options) => this.#run('stageSelection', request, options),
      stageHunk: (request, options) => this.#run('stageHunk', request, options),
      getConflicts: (request, options) => this.#run('getConflicts', request, options),
      getConflictDetails: (request, options) => this.#run('getConflictDetails', request, options),
      acceptConflictSide: (request, options) => this.#run('acceptConflictSide', request, options),
      markConflictResolved: (request, options) => this.#run('markConflictResolved', request, options),
      getStashes: (request, options) => this.#run('getStashes', request, options),
      createStash: (request, options) => this.#run('createStash', request, options),
      applyStash: (request, options) => this.#run('applyStash', request, options),
      popStash: (request, options) => this.#run('popStash', request, options),
      dropStash: (request, options) => this.#run('dropStash', request, options),
      getFileHistory: (request, options) => this.#run('getFileHistory', request, options),
      getBlame: (request, options) => this.#run('getBlame', request, options),
      getGraph: (request, options) => this.#run('getGraph', request, options),
      getRepoInfo: (request, options) => this.#run('getRepoInfo', request, options),
      getWorktrees: (request, options) => this.#run('getWorktrees', request, options),
      getTargetCandidates: (request, options) => this.#run('getTargetCandidates', request, options),
      createWorktree: (request, options) => this.#run('createWorktree', request, options),
      removeWorktree: (request, options) => this.#run('removeWorktree', request, options),
      commitIndex: (request, options) => this.#run('commitIndex', request, options),
      stagePaths: (request, options) => this.#run('stagePaths', request, options),
      revertCommit: (request, options) => this.#run('revertCommit', request, options),
      collectCommitMessageContext: (request, options) => this.#run('collectCommitMessageContext', request, options),
    };
  }
}

function portableResult<T>(result: T): T {
  if (!isRecord(result)) return result;
  const convert = (value: Record<string, unknown>, keys: readonly string[]) => {
    for (const key of keys) if (typeof value[key] === 'string') value[key] = toNodePath(value[key]);
  };
  convert(result, ['project', 'repoRoot', 'currentWorktreePath', 'worktreePath']);
  if (isRecord(result.target)) convert(result.target, ['projectPath', 'repoRoot', 'worktreePath']);
  if (isRecord(result.reviewSummary)) convert(result.reviewSummary, ['project']);
  if (Array.isArray(result.worktrees)) for (const entry of result.worktrees) if (isRecord(entry)) convert(entry, ['path']);
  if (Array.isArray(result.targets)) for (const entry of result.targets) if (isRecord(entry)) convert(entry, ['projectPath', 'repoRoot', 'worktreePath']);
  return result;
}
