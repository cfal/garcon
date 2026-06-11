import { createGitService } from '../git/git-service.js';
import { classifyGitError } from '../git/git-error-classifier.js';
import { resolveEffectiveGenerationUiConfig } from '../settings/generation-effective.js';
import { resolveGenerationContext } from '../settings/generation-config-source.ts';
import { isAgentId } from '../../common/agents.ts';
import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { SettingsStore } from '../settings/store.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import {
  assertWithinProjectBase,
  isProjectBoundaryError,
  projectBoundaryErrorResponse,
} from '../lib/path-boundary.ts';
import { asJsonBody, type JsonBody } from './route-helpers.js';

type GitMode = 'working' | 'staged';
type StageMode = 'stage' | 'unstage';
type RevertStrategy = 'revert' | 'reset-soft';

interface GitRouteOptions {
  projectPath: string;
  [key: string]: unknown;
}

interface GitRouteService {
  toHttpError(error: unknown): Response;
  getStatus(options: GitRouteOptions): Promise<unknown>;
  getDiff(options: GitRouteOptions): Promise<unknown>;
  getFileWithDiff(options: GitRouteOptions): Promise<unknown>;
  initialCommit(options: GitRouteOptions): Promise<unknown>;
  commit(options: GitRouteOptions): Promise<unknown>;
  getBranches(options: GitRouteOptions): Promise<unknown>;
  checkout(options: GitRouteOptions): Promise<unknown>;
  createBranch(options: GitRouteOptions): Promise<unknown>;
  getCommits(options: GitRouteOptions): Promise<unknown>;
  getCommitDiff(options: GitRouteOptions): Promise<unknown>;
  generateCommitMessageForFiles(options: GitRouteOptions): Promise<unknown>;
  getRemoteStatus(options: GitRouteOptions): Promise<unknown>;
  fetch(options: GitRouteOptions): Promise<unknown>;
  pull(options: GitRouteOptions): Promise<unknown>;
  push(options: GitRouteOptions): Promise<unknown>;
  getRemotes(options: GitRouteOptions): Promise<unknown>;
  discard(options: GitRouteOptions): Promise<unknown>;
  deleteUntracked(options: GitRouteOptions): Promise<unknown>;
  getFileReviewData(options: GitRouteOptions): Promise<unknown>;
  getChangesTree(options: GitRouteOptions): Promise<unknown>;
  getFileReviewDataBatch(options: GitRouteOptions): Promise<unknown>;
  stageSelection(options: GitRouteOptions): Promise<unknown>;
  stageHunk(options: GitRouteOptions): Promise<unknown>;
  getRepoInfo(options: GitRouteOptions): Promise<unknown>;
  getWorktrees(options: GitRouteOptions): Promise<unknown>;
  getTargetCandidates(options: GitRouteOptions): Promise<unknown>;
  createWorktree(options: GitRouteOptions): Promise<unknown>;
  removeWorktree(options: GitRouteOptions): Promise<unknown>;
  commitIndex(options: GitRouteOptions): Promise<unknown>;
  stageFile(options: GitRouteOptions): Promise<unknown>;
  revertLastCommit(options: GitRouteOptions): Promise<unknown>;
}

interface ProxiedGitRouteService extends GitRouteService {
  [key: string]: unknown;
}

interface GitServiceFactoryResult {
  [key: string]: unknown;
}

interface StageSelectionInput {
  lineIndices: number[];
}

function hasOwn(source: unknown, key: string): source is Record<string, unknown> {
  return Boolean(source) && Object.prototype.hasOwnProperty.call(source, key);
}

function optionalId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(value) ? value : null;
}

function optionalProtocol(value: unknown): ApiProtocol | null {
  return value === 'openai-compatible' || value === 'anthropic-messages' ? value : null;
}

function isAllowedGenerationAgent(agents: AgentRegistryServiceContract, value: unknown): boolean {
  if (!isAgentId(value)) return false;
  if (typeof agents?.hasAgent === 'function') {
    return agents.hasAgent(value);
  }
  return true;
}

async function resolveCommitMessageConfig(settings: SettingsStore, agents: AgentRegistryServiceContract) {
  const ui = await settings?.getUiSettings?.() ?? {};
  const generationContext = await resolveGenerationContext(agents);
  return resolveEffectiveGenerationUiConfig({
    persisted: ui?.commitMessage,
    ...generationContext,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isValidLineIndices(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNonNegativeInteger);
}

function isGitRouteOptions(value: unknown): value is GitRouteOptions {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundaryCheckedOptions(options: unknown): unknown {
  if (!options || typeof options !== 'object') return options;
  const next = { ...options as Record<string, unknown> };
  if (typeof next.projectPath === 'string') {
    next.projectPath = assertWithinProjectBase(next.projectPath);
  }
  if (typeof next.worktreePath === 'string') {
    next.worktreePath = assertWithinProjectBase(next.worktreePath);
  }
  return next;
}

function createBoundaryCheckedGitService(git: GitServiceFactoryResult): GitRouteService {
  return new Proxy(git, {
    get(target: GitServiceFactoryResult, prop: string | symbol, receiver: unknown): unknown {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'toHttpError' && typeof value === 'function') {
        return (error: unknown) => isProjectBoundaryError(error)
          ? projectBoundaryErrorResponse()
          : value.call(target, error);
      }
      if (typeof value !== 'function') return value;
      return (options: unknown, ...args: unknown[]) => value.call(target, boundaryCheckedOptions(options), ...args);
    },
  }) as ProxiedGitRouteService;
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(isNonEmptyString) ? value : null;
}

function validMode(value: unknown): GitMode | null {
  return value === 'working' || value === 'staged' ? value : null;
}

function validStageMode(value: unknown): StageMode | null {
  return value === 'stage' || value === 'unstage' ? value : null;
}

function validSelection(value: unknown): StageSelectionInput | null {
  if (!isGitRouteOptions(value) || !isValidLineIndices(value.lineIndices)) return null;
  return { lineIndices: value.lineIndices };
}

export default function createGitRoutes(
  agents: AgentRegistryServiceContract,
  settings: SettingsStore,
): RouteMap {
  const git = createBoundaryCheckedGitService(createGitService({ agents, classifyGitError }));

  async function getStatus(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }

    try {
      const result = await git.getStatus({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getDiff(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    const file = url.searchParams.get('file');
    if (!project || !file) {
      return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
    }

    try {
      const result = await git.getDiff({ projectPath: project, file });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getFileWithDiff(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    const file = url.searchParams.get('file');
    if (!project || !file) {
      return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
    }

    try {
      const result = await git.getFileWithDiff({ projectPath: project, file });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postInitialCommit(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }

      const result = await git.initialCommit({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postCommit(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const message = requiredString(input.message);
      const files = stringArray(input.files);
      if (!project || !message || !files || files.length === 0) {
        return Response.json({ error: 'Missing required parameters: project, message, and files.' }, { status: 400 });
      }

      const result = await git.commit({ projectPath: project, message, files });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getBranches(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }

    try {
      const result = await git.getBranches({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postCheckout(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const branch = requiredString(input.branch);
      if (!project || !branch) {
        return Response.json({ error: 'Missing required parameters: project and branch.' }, { status: 400 });
      }

      const result = await git.checkout({ projectPath: project, branch });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postCreateBranch(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const branch = requiredString(input.branch);
      if (!project || !branch) {
        return Response.json({ error: 'Missing required parameters: project and branchName.' }, { status: 400 });
      }

      const result = await git.createBranch({ projectPath: project, branch });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getCommits(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    const limit = url.searchParams.get('limit') || '10';
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }

    try {
      const result = await git.getCommits({ projectPath: project, limit });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getCommitDiff(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    const commit = url.searchParams.get('commit');
    if (!project || !commit) {
      return Response.json({ error: 'Missing required parameters: project and commitHash.' }, { status: 400 });
    }

    try {
      const result = await git.getCommitDiff({ projectPath: project, commit });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postGenerateCommitMessage(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const files = stringArray(input.files);
      if (!project || !files || files.length === 0) {
        return Response.json({ error: 'Missing required parameters: project and files.' }, { status: 400 });
      }
      if (hasOwn(input, 'agentId') && !isAllowedGenerationAgent(agents, input.agentId)) {
        return Response.json({ error: 'Invalid agent.' }, { status: 400 });
      }

      const persistedConfig = await resolveCommitMessageConfig(settings, agents);
      const agentId = hasOwn(input, 'agentId') && isAgentId(input.agentId) ? input.agentId : persistedConfig.agentId;
      const model = hasOwn(input, 'model')
        ? (typeof input.model === 'string' ? input.model : '')
        : (typeof persistedConfig.model === 'string' ? persistedConfig.model : '');
      const apiProviderId = hasOwn(input, 'apiProviderId')
        ? optionalId(input.apiProviderId)
        : (persistedConfig.apiProviderId ?? null);
      const modelEndpointId = hasOwn(input, 'modelEndpointId')
        ? optionalId(input.modelEndpointId)
        : (persistedConfig.modelEndpointId ?? null);
      const modelProtocol = hasOwn(input, 'modelProtocol')
        ? optionalProtocol(input.modelProtocol)
        : (persistedConfig.modelProtocol ?? null);
      const customPrompt = hasOwn(input, 'customPrompt')
        ? (typeof input.customPrompt === 'string' ? input.customPrompt : '')
        : (typeof persistedConfig.customPrompt === 'string' ? persistedConfig.customPrompt : '');

      const result = await git.generateCommitMessageForFiles({
        projectPath: project,
        files,
        agentId,
        model,
        apiProviderId,
        modelEndpointId,
        modelProtocol,
        customPrompt,
      });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getRemoteStatus(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }

    try {
      const result = await git.getRemoteStatus({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postFetch(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }

      const result = await git.fetch({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postPull(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }

      const result = await git.pull({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postPush(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const remote = typeof input.remote === 'string' ? input.remote : undefined;
      const remoteBranch = typeof input.remoteBranch === 'string' ? input.remoteBranch : undefined;
      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }

      const result = await git.push({ projectPath: project, remote, remoteBranch });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getRemotes(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }

    try {
      const result = await git.getRemotes({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postDiscard(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const file = requiredString(input.file);
      if (!project || !file) {
        return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
      }

      const result = await git.discard({ projectPath: project, file });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postDeleteUntracked(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const file = requiredString(input.file);
      if (!project || !file) {
        return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
      }

      const result = await git.deleteUntracked({ projectPath: project, file });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getFileReviewData(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    const file = url.searchParams.get('file');
    const mode = validMode(url.searchParams.get('mode') || 'working');
    const context = Number(url.searchParams.get('context') || 5);

    if (!project || !file) {
      return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
    }
    if (!mode) {
      return Response.json({ error: 'Invalid mode. Expected one of: working, staged.' }, { status: 400 });
    }

    try {
      const result = await git.getFileReviewData({ projectPath: project, file, mode, context });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getChangesTree(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }

    try {
      const result = await git.getChangesTree({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postFileReviewDataBatch(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const files = stringArray(input.files);
      const mode = validMode(input.mode);
      const context = input.context;

      if (!project || !files || files.length === 0) {
        return Response.json({ error: 'Missing required parameters: project and files.' }, { status: 400 });
      }
      if (!mode) {
        return Response.json({ error: 'Invalid mode. Expected one of: working, staged.' }, { status: 400 });
      }

      const result = await git.getFileReviewDataBatch({
        projectPath: project,
        files,
        mode,
        context: typeof context === 'number' ? context : 5,
      });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postStageSelection(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const file = requiredString(input.file);
      const modeRaw = input.mode;
      const mode = validStageMode(modeRaw);
      const selection = validSelection(input.selection);
      const contextLines = input.contextLines;

      if (!project || !file || !modeRaw || !selection?.lineIndices) {
        return Response.json({ error: 'Missing required parameters: project, file, mode, and selection.lineIndices.' }, { status: 400 });
      }
      if (!mode) {
        return Response.json({ error: 'Invalid mode. Expected one of: stage, unstage.' }, { status: 400 });
      }

      const result = await git.stageSelection({
        projectPath: project, file, mode, selection,
        contextLines: typeof contextLines === 'number' ? contextLines : 5,
      });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postStageHunk(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const file = requiredString(input.file);
      const modeRaw = input.mode;
      const mode = validStageMode(modeRaw);
      const hunkIndex = input.hunkIndex;
      const contextLines = input.contextLines;

      if (!project || !file || !modeRaw || hunkIndex === undefined) {
        return Response.json({ error: 'Missing required parameters: project, file, mode, and hunkIndex.' }, { status: 400 });
      }
      if (!mode) {
        return Response.json({ error: 'Invalid mode. Expected one of: stage, unstage.' }, { status: 400 });
      }
      if (!isNonNegativeInteger(hunkIndex)) {
        return Response.json({ error: 'hunkIndex must be a non-negative integer.' }, { status: 400 });
      }

      const result = await git.stageHunk({
        projectPath: project, file, mode, hunkIndex,
        contextLines: typeof contextLines === 'number' ? contextLines : 5,
      });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getRepoInfo(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }

    try {
      const result = await git.getRepoInfo({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getWorktrees(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }

    try {
      const result = await git.getWorktrees({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getTargets(_request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }

    try {
      const result = await git.getTargetCandidates({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postCreateWorktree(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const baseRef = typeof input.baseRef === 'string' ? input.baseRef : undefined;
      const worktreePath = requiredString(input.worktreePath);
      const branch = typeof input.branch === 'string' ? input.branch : undefined;
      const detach = input.detach === true;

      if (!project || !worktreePath) {
        return Response.json({ error: 'Missing required parameters: project and worktreePath.' }, { status: 400 });
      }

      const result = await git.createWorktree({ projectPath: project, baseRef, worktreePath, branch, detach });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postRemoveWorktree(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const worktreePath = requiredString(input.worktreePath);
      const force = input.force === true;

      if (!project || !worktreePath) {
        return Response.json({ error: 'Missing required parameters: project and worktreePath.' }, { status: 400 });
      }

      const result = await git.removeWorktree({ projectPath: project, worktreePath, force });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postCommitIndex(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const message = requiredString(input.message);

      if (!project || !message) {
        return Response.json({ error: 'Missing required parameters: project and message.' }, { status: 400 });
      }

      const result = await git.commitIndex({ projectPath: project, message });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postStageFile(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const file = requiredString(input.file);
      const modeRaw = input.mode;
      const mode = validStageMode(modeRaw);

      if (!project || !file || !modeRaw) {
        return Response.json({ error: 'Missing required parameters: project, file, and mode.' }, { status: 400 });
      }
      if (!mode) {
        return Response.json({ error: 'Invalid mode. Expected one of: stage, unstage.' }, { status: 400 });
      }

      const result = await git.stageFile({ projectPath: project, file, mode });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postRevertLastCommit(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const strategy = input.strategy;

      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }

      const effectiveStrategy = strategy || 'revert';
      if (effectiveStrategy !== 'revert' && effectiveStrategy !== 'reset-soft') {
        return Response.json({ error: 'Invalid strategy. Expected one of: revert, reset-soft.' }, { status: 400 });
      }

      const result = await git.revertLastCommit({ projectPath: project, strategy: effectiveStrategy as RevertStrategy });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  return {
    '/api/v1/git/status': { GET: getStatus },
    '/api/v1/git/diff': { GET: getDiff },
    '/api/v1/git/file-with-diff': { GET: getFileWithDiff },
    '/api/v1/git/initial-commit': { POST: withJsonBody(postInitialCommit) },
    '/api/v1/git/commit': { POST: withJsonBody(postCommit) },
    '/api/v1/git/branches': { GET: getBranches },
    '/api/v1/git/checkout': { POST: withJsonBody(postCheckout) },
    '/api/v1/git/create-branch': { POST: withJsonBody(postCreateBranch) },
    '/api/v1/git/commits': { GET: getCommits },
    '/api/v1/git/commit-diff': { GET: getCommitDiff },
    '/api/v1/git/generate-commit-message': { POST: withJsonBody(postGenerateCommitMessage) },
    '/api/v1/git/remote-status': { GET: getRemoteStatus },
    '/api/v1/git/fetch': { POST: withJsonBody(postFetch) },
    '/api/v1/git/pull': { POST: withJsonBody(postPull) },
    '/api/v1/git/push': { POST: withJsonBody(postPush) },
    '/api/v1/git/remotes': { GET: getRemotes },
    '/api/v1/git/discard': { POST: withJsonBody(postDiscard) },
    '/api/v1/git/delete-untracked': { POST: withJsonBody(postDeleteUntracked) },
    '/api/v1/git/file-review-data': { GET: getFileReviewData },
    '/api/v1/git/file-review-data/batch': { POST: withJsonBody(postFileReviewDataBatch) },
    '/api/v1/git/changes-tree': { GET: getChangesTree },
    '/api/v1/git/stage-selection': { POST: withJsonBody(postStageSelection) },
    '/api/v1/git/stage-hunk': { POST: withJsonBody(postStageHunk) },
    '/api/v1/git/repo-info': { GET: getRepoInfo },
    '/api/v1/git/worktrees': { GET: getWorktrees },
    '/api/v1/git/targets': { GET: getTargets },
    '/api/v1/git/worktrees/create': { POST: withJsonBody(postCreateWorktree) },
    '/api/v1/git/worktrees/remove': { POST: withJsonBody(postRemoveWorktree) },
    '/api/v1/git/revert-last-commit': { POST: withJsonBody(postRevertLastCommit) },
    '/api/v1/git/commit-index': { POST: withJsonBody(postCommitIndex) },
    '/api/v1/git/stage-file': { POST: withJsonBody(postStageFile) },
  };
}
