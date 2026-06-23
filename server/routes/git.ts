import { createGitService } from '../git/git-service.js';
import type { GitService } from '../git/git-service.js';
import {
  GIT_DIFF_LIMITS,
  GIT_REVIEW_DOCUMENT_LIMITS,
  type GitCommandTrace,
} from '../git/types.js';
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
  assertRealWithinProjectBase,
  isProjectBoundaryError,
  projectBoundaryErrorResponse,
} from '../lib/path-boundary.ts';
import { createLogger } from '../lib/log.js';
import { asJsonBody, type JsonBody } from './route-helpers.js';

type GitMode = 'working' | 'staged';
type StageMode = 'stage' | 'unstage';
type RevertStrategy = 'revert' | 'reset-soft';

const logger = createLogger('routes:git');
const MAX_HISTORY_LIST_LIMIT = 200;
const MAX_HISTORY_OFFSET = 100_000;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function boundaryCheckedOptions(options: unknown): Promise<unknown> {
  if (!options || typeof options !== 'object') return options;
  const next = { ...options as Record<string, unknown> };
  if (typeof next.projectPath === 'string') {
    next.projectPath = await assertRealWithinProjectBase(next.projectPath);
  }
  if (typeof next.worktreePath === 'string') {
    next.worktreePath = await assertRealWithinProjectBase(next.worktreePath);
  }
  return next;
}

function createBoundaryCheckedGitService(git: GitService): GitService {
  return new Proxy(git, {
    get(target: GitService, prop: string | symbol, receiver: unknown): unknown {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'toHttpError' && typeof value === 'function') {
        return (error: unknown) => isProjectBoundaryError(error)
          ? projectBoundaryErrorResponse()
          : value.call(target, error);
      }
      if (typeof value !== 'function') return value;
      return async (options: unknown, ...args: unknown[]) => value.call(target, await boundaryCheckedOptions(options), ...args);
    },
  }) as unknown as GitService;
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalString(value: unknown): string | null {
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
  if (!isRecord(value) || !isValidLineIndices(value.lineIndices)) return null;
  return { lineIndices: value.lineIndices };
}

function validContextLines(value: unknown): number | null {
  const context = typeof value === 'number' ? value : Number(value ?? 5);
  if (!Number.isInteger(context) || context < 0 || context > GIT_DIFF_LIMITS.maxContextLines) {
    return null;
  }
  return context;
}

function validPositiveLimit(value: unknown, fallback: number, max: number): number | null {
  const limit = value === null || value === undefined ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit <= 0 || limit > max) return null;
  return limit;
}

function validNonNegativeInteger(value: unknown, fallback: number, max: number): number | null {
  const next = value === null || value === undefined ? fallback : Number(value);
  if (!Number.isInteger(next) || next < 0 || next > max) return null;
  return next;
}

function traceJsonResponse(route: string, startedAt: number, trace: GitCommandTrace[], body: unknown): Response {
  const responseBytes = Buffer.byteLength(JSON.stringify(body));
  const slowestCommand = [...trace].sort((a, b) => b.durationMs - a.durationMs)[0];
  logger.debug('git workbench route', {
    route,
    durationMs: Math.round(performance.now() - startedAt),
    commandCount: trace.length,
    slowestCommand,
    responseBytes,
  });
  return Response.json(body);
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

  async function postHistoryCommits(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const ref = optionalString(input.ref) ?? 'HEAD';
      const limit = validPositiveLimit(input.limit, 50, MAX_HISTORY_LIST_LIMIT);
      const offset = validNonNegativeInteger(input.offset, 0, MAX_HISTORY_OFFSET);

      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }
      if (limit === null || offset === null) {
        return Response.json({ error: 'Invalid history pagination parameters.' }, { status: 400 });
      }

      const trace: GitCommandTrace[] = [];
      const startedAt = performance.now();
      const result = await git.getHistoryCommits({
        projectPath: project,
        ref,
        limit,
        offset,
        trace,
        signal: request.signal,
      });
      return traceJsonResponse('history-commits', startedAt, trace, result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postCommitSnapshot(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const commit = requiredString(input.commit);
      const parent = optionalString(input.parent);
      const context = validContextLines(input.context ?? 5);
      const bodyCandidateCount = validPositiveLimit(
        input.bodyCandidateCount,
        8,
        GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles,
      );

      if (!project || !commit) {
        return Response.json({ error: 'Missing required parameters: project and commit.' }, { status: 400 });
      }
      if (context === null || bodyCandidateCount === null) {
        return Response.json({ error: 'Invalid commit snapshot parameters.' }, { status: 400 });
      }

      const trace: GitCommandTrace[] = [];
      const startedAt = performance.now();
      const result = await git.getCommitSnapshot({
        projectPath: project,
        commit,
        parent,
        context,
        bodyCandidateCount,
        trace,
        signal: request.signal,
      });
      return traceJsonResponse('history-commit-snapshot', startedAt, trace, result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postCommitFiles(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const documentId = requiredString(input.documentId);
      const commit = requiredString(input.commit);
      const parent = optionalString(input.parent);
      const context = validContextLines(input.context ?? 5);
      const files = stringArray(input.files);

      if (!project || !documentId || !commit || !files || files.length === 0) {
        return Response.json(
          { error: 'Missing required parameters: project, documentId, commit, and files.' },
          { status: 400 },
        );
      }
      if (context === null) {
        return Response.json({ error: 'Invalid context line count.' }, { status: 400 });
      }
      if (files.length > GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles) {
        return Response.json(
          { error: `Too many files. Maximum is ${GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles}.` },
          { status: 400 },
        );
      }

      const trace: GitCommandTrace[] = [];
      const startedAt = performance.now();
      const result = await git.getCommitFileBodies({
        projectPath: project,
        documentId,
        commit,
        parent,
        context,
        files,
        trace,
        signal: request.signal,
      });
      return traceJsonResponse('history-commit-files', startedAt, trace, result);
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

  async function postWorkbenchSnapshot(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const mode = validMode(input.mode);
      const context = validContextLines(input.context ?? 5);
      const selectedFile = optionalString(input.selectedFile);
      const bodyCandidateCount = validPositiveLimit(
        input.bodyCandidateCount,
        8,
        GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles,
      );

      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }
      if (!mode) {
        return Response.json({ error: 'Invalid mode. Expected one of: working, staged.' }, { status: 400 });
      }
      if (context === null) {
        return Response.json(
          { error: `Invalid context. Expected an integer between 0 and ${GIT_DIFF_LIMITS.maxContextLines}.` },
          { status: 400 },
        );
      }
      if (bodyCandidateCount === null) {
        return Response.json({ error: 'Invalid bodyCandidateCount.' }, { status: 400 });
      }

      const trace: GitCommandTrace[] = [];
      const startedAt = performance.now();
      const result = await git.getWorkbenchSnapshot({
        projectPath: project,
        mode,
        context,
        selectedFile,
        bodyCandidateCount,
        trace,
        signal: request.signal,
      });
      return traceJsonResponse('workbench-snapshot', startedAt, trace, result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postWorkbenchFingerprint(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);

      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }

      const trace: GitCommandTrace[] = [];
      const startedAt = performance.now();
      const result = await git.getWorkbenchFingerprint({
        projectPath: project,
        trace,
        signal: request.signal,
      });
      return traceJsonResponse('workbench-fingerprint', startedAt, trace, result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postReviewDocumentFiles(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const documentId = requiredString(input.documentId);
      const files = stringArray(input.files);
      const mode = validMode(input.mode);
      const context = validContextLines(input.context ?? 5);

      if (!project || !documentId || !files || files.length === 0) {
        return Response.json({ error: 'Missing required parameters: project, documentId, and files.' }, { status: 400 });
      }
      if (!mode) {
        return Response.json({ error: 'Invalid mode. Expected one of: working, staged.' }, { status: 400 });
      }
      if (context === null) {
        return Response.json(
          { error: `Invalid context. Expected an integer between 0 and ${GIT_DIFF_LIMITS.maxContextLines}.` },
          { status: 400 },
        );
      }
      if (files.length > GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles) {
        return Response.json(
          { error: `Too many files. Maximum is ${GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles}.` },
          { status: 400 },
        );
      }

      const result = await git.getReviewFileBodies({
        projectPath: project,
        documentId,
        files,
        mode,
        context,
        signal: request.signal,
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
      const selectionRaw = input.selection;
      const selection = validSelection(selectionRaw);
      const contextLines = input.contextLines;

      if (!project || !file || !modeRaw || !selectionRaw) {
        return Response.json({ error: 'Missing required parameters: project, file, mode, and selection.lineIndices.' }, { status: 400 });
      }
      if (!mode) {
        return Response.json({ error: 'Invalid mode. Expected one of: stage, unstage.' }, { status: 400 });
      }
      if (!selection) {
        return Response.json({ error: 'selection.lineIndices must be an array of non-negative integers.' }, { status: 400 });
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

  async function getConflicts(request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }
    try {
      const result = await git.getConflicts({ projectPath: project, signal: request.signal });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getConflictDetails(request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    const file = url.searchParams.get('file');
    if (!project || !file) {
      return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
    }
    try {
      const result = await git.getConflictDetails({ projectPath: project, file, signal: request.signal });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postAcceptConflictSide(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const file = requiredString(input.file);
      const side = input.side;
      if (!project || !file || (side !== 'ours' && side !== 'theirs')) {
        return Response.json(
          { error: 'Missing or invalid parameters: project, file, and side.' },
          { status: 400 },
        );
      }
      const result = await git.acceptConflictSide({
        projectPath: project,
        file,
        side,
        signal: request.signal,
      });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postMarkConflictResolved(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const file = requiredString(input.file);
      if (!project || !file) {
        return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
      }
      const result = await git.markConflictResolved({ projectPath: project, file, signal: request.signal });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getStashes(request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }
    try {
      const result = await git.getStashes({ projectPath: project, signal: request.signal });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postCreateStash(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }
      const result = await git.createStash({
        projectPath: project,
        message: typeof input.message === 'string' ? input.message : undefined,
        includeUntracked: input.includeUntracked === true,
        signal: request.signal,
      });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postApplyStash(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const stashRef = requiredString(input.stashRef);
      if (!project || !stashRef) {
        return Response.json({ error: 'Missing required parameters: project and stashRef.' }, { status: 400 });
      }
      const result = await git.applyStash({ projectPath: project, stashRef, signal: request.signal });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postPopStash(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const stashRef = requiredString(input.stashRef);
      if (!project || !stashRef) {
        return Response.json({ error: 'Missing required parameters: project and stashRef.' }, { status: 400 });
      }
      const result = await git.popStash({ projectPath: project, stashRef, signal: request.signal });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postDropStash(body: JsonBody, request: Request): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const project = requiredString(input.project);
      const stashRef = requiredString(input.stashRef);
      if (!project || !stashRef) {
        return Response.json({ error: 'Missing required parameters: project and stashRef.' }, { status: 400 });
      }
      const result = await git.dropStash({ projectPath: project, stashRef, signal: request.signal });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getFileHistory(request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    const file = url.searchParams.get('file');
    const limit = validPositiveLimit(url.searchParams.get('limit'), 50, 200);
    if (!project || !file) {
      return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
    }
    if (limit === null) {
      return Response.json({ error: 'Invalid limit. Expected an integer between 1 and 200.' }, { status: 400 });
    }
    try {
      const result = await git.getFileHistory({
        projectPath: project,
        file,
        limit,
        signal: request.signal,
      });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getBlame(request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    const file = url.searchParams.get('file');
    const limit = validPositiveLimit(url.searchParams.get('limit'), 2000, 2000);
    const ref = url.searchParams.get('ref') || 'HEAD';
    if (!project || !file) {
      return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
    }
    if (limit === null) {
      return Response.json({ error: 'Invalid limit. Expected an integer between 1 and 2000.' }, { status: 400 });
    }
    try {
      const result = await git.getBlame({ projectPath: project, file, ref, limit, signal: request.signal });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getGraph(request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    const limit = validPositiveLimit(url.searchParams.get('limit'), 200, 500);
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }
    if (limit === null) {
      return Response.json({ error: 'Invalid limit. Expected an integer between 1 and 500.' }, { status: 400 });
    }
    try {
      const result = await git.getGraph({ projectPath: project, limit, signal: request.signal });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getCompare(request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    const base = url.searchParams.get('base');
    const head = url.searchParams.get('head');
    if (!project || !base || !head) {
      return Response.json({ error: 'Missing required parameters: project, base, and head.' }, { status: 400 });
    }
    try {
      const result = await git.getCompare({ projectPath: project, base, head, signal: request.signal });
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
    '/api/v1/git/history/commits': { POST: withJsonBody(postHistoryCommits) },
    '/api/v1/git/history/commit/snapshot': { POST: withJsonBody(postCommitSnapshot) },
    '/api/v1/git/history/commit/files': { POST: withJsonBody(postCommitFiles) },
    '/api/v1/git/generate-commit-message': { POST: withJsonBody(postGenerateCommitMessage) },
    '/api/v1/git/remote-status': { GET: getRemoteStatus },
    '/api/v1/git/fetch': { POST: withJsonBody(postFetch) },
    '/api/v1/git/pull': { POST: withJsonBody(postPull) },
    '/api/v1/git/push': { POST: withJsonBody(postPush) },
    '/api/v1/git/remotes': { GET: getRemotes },
    '/api/v1/git/discard': { POST: withJsonBody(postDiscard) },
    '/api/v1/git/delete-untracked': { POST: withJsonBody(postDeleteUntracked) },
    '/api/v1/git/workbench/snapshot': { POST: withJsonBody(postWorkbenchSnapshot) },
    '/api/v1/git/workbench/fingerprint': { POST: withJsonBody(postWorkbenchFingerprint) },
    '/api/v1/git/review-document/files': { POST: withJsonBody(postReviewDocumentFiles) },
    '/api/v1/git/stage-selection': { POST: withJsonBody(postStageSelection) },
    '/api/v1/git/stage-hunk': { POST: withJsonBody(postStageHunk) },
    '/api/v1/git/worktrees': { GET: getWorktrees },
    '/api/v1/git/targets': { GET: getTargets },
    '/api/v1/git/worktrees/create': { POST: withJsonBody(postCreateWorktree) },
    '/api/v1/git/worktrees/remove': { POST: withJsonBody(postRemoveWorktree) },
    '/api/v1/git/revert-last-commit': { POST: withJsonBody(postRevertLastCommit) },
    '/api/v1/git/commit-index': { POST: withJsonBody(postCommitIndex) },
    '/api/v1/git/stage-file': { POST: withJsonBody(postStageFile) },
    '/api/v1/git/conflicts': { GET: getConflicts },
    '/api/v1/git/conflict-details': { GET: getConflictDetails },
    '/api/v1/git/conflict/accept': { POST: withJsonBody(postAcceptConflictSide) },
    '/api/v1/git/conflict/resolve': { POST: withJsonBody(postMarkConflictResolved) },
    '/api/v1/git/stashes': { GET: getStashes },
    '/api/v1/git/stash/create': { POST: withJsonBody(postCreateStash) },
    '/api/v1/git/stash/apply': { POST: withJsonBody(postApplyStash) },
    '/api/v1/git/stash/pop': { POST: withJsonBody(postPopStash) },
    '/api/v1/git/stash/drop': { POST: withJsonBody(postDropStash) },
    '/api/v1/git/file-history': { GET: getFileHistory },
    '/api/v1/git/blame': { GET: getBlame },
    '/api/v1/git/graph': { GET: getGraph },
    '/api/v1/git/compare': { GET: getCompare },
  };
}
