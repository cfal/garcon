import { createGitService } from '../git/git-service.js';
import type { GitService } from '../git/git-service.js';
import {
  GIT_DIFF_LIMITS,
  GIT_REF_RESULT_LIMITS,
  GIT_REVIEW_DOCUMENT_LIMITS,
  type GitCommandTrace,
  type GitRefKind,
} from '../git/types.js';
import { classifyGitError } from '../git/git-error-classifier.js';
import { resolveEffectiveGenerationUiConfig } from '../settings/generation-effective.js';
import { resolveGenerationContextForSelection } from '../settings/generation-config-source.ts';
import { isAgentId } from '../../common/agents.ts';
import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { SettingsStore } from '../settings/store.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import { isThinkingMode } from '../../common/chat-modes.js';
import { isRecord } from '../../common/json.js';
import { createGenerationRequestSignal } from '../settings/generation-limits.js';
import {
  assertRealWithinProjectBase,
  isProjectBoundaryError,
  projectBoundaryErrorResponse,
} from '../lib/path-boundary.ts';
import { createLogger } from '../lib/log.js';
import { jsonError } from '../lib/http-error.js';
import { asJsonBody, type JsonBody } from './route-helpers.js';
import { createGitComparisonRoutes } from './git-comparisons.js';

type GitMode = 'working' | 'staged';
type StageMode = 'stage' | 'unstage';

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

function hasGenerationRoutingOverride(input: Record<string, unknown>): boolean {
  return ['agentId', 'model', 'apiProviderId', 'modelEndpointId', 'modelProtocol']
    .some((key) => hasOwn(input, key));
}

function isAllowedGenerationAgent(agents: AgentRegistryServiceContract, value: unknown): boolean {
  if (!isAgentId(value)) return false;
  if (typeof agents?.hasAgent === 'function') {
    return agents.hasAgent(value);
  }
  return true;
}

async function resolveCommitMessageConfig(
  settings: SettingsStore,
  agents: AgentRegistryServiceContract,
  signal?: AbortSignal,
) {
  const ui = await settings?.getUiSettings?.() ?? {};
  const generationContext = await resolveGenerationContextForSelection(
    agents,
    ui?.commitMessage,
    signal,
  );
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
  });
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function gitRouteError(error: string, status = 400): Response {
  return jsonError(error, status);
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

function isGitRefKind(value: unknown): value is GitRefKind {
  return value === 'local-branch' || value === 'remote-branch' || value === 'tag' || value === 'other';
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

type GitRouteResult = Response | unknown;

async function gitJson(git: GitService, action: () => Promise<GitRouteResult> | GitRouteResult): Promise<Response> {
  try {
    const result = await action();
    return result instanceof Response ? result : Response.json(result);
  } catch (error) {
    return git.toHttpError(error);
  }
}

function requiredQueryStrings(url: URL, names: string[], message: string): Record<string, string> | Response {
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (!value) return gitRouteError(message, 400);
    values[name] = value;
  }
  return values;
}

function requiredProjectFromQuery(url: URL): string | Response {
  const project = url.searchParams.get('project');
  return project || gitRouteError('Missing required parameter: project.', 400);
}

function requiredProjectFromBody(input: Record<string, unknown>): string | Response {
  const project = nonEmptyString(input.project);
  return project || gitRouteError('Missing required parameter: project.', 400);
}

export default function createGitRoutes(
  agents: AgentRegistryServiceContract,
  settings: SettingsStore,
): RouteMap {
  const git = createBoundaryCheckedGitService(createGitService({ agents, classifyGitError }));

  async function getStatus(_request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getStatus({ projectPath: project }));
  }

  async function getDiff(_request: Request, url: URL): Promise<Response> {
    const input = requiredQueryStrings(url, ['project', 'file'], 'Missing required parameters: project and file.');
    if (input instanceof Response) return input;
    return gitJson(git, () => git.getDiff({ projectPath: input.project, file: input.file }));
  }

  async function getFileWithDiff(_request: Request, url: URL): Promise<Response> {
    const input = requiredQueryStrings(url, ['project', 'file'], 'Missing required parameters: project and file.');
    if (input instanceof Response) return input;
    return gitJson(git, () => git.getFileWithDiff({ projectPath: input.project, file: input.file }));
  }

  async function postInitialCommit(body: JsonBody): Promise<Response> {
    const project = requiredProjectFromBody(asJsonBody(body));
    if (project instanceof Response) return project;
    return gitJson(git, () => git.initialCommit({ projectPath: project }));
  }

  async function postCommit(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const message = nonEmptyString(input.message);
      const files = stringArray(input.files);
      if (!project || !message || !files || files.length === 0) {
        return gitRouteError('Missing required parameters: project, message, and files.', 400);
      }

      return git.commit({ projectPath: project, message, files });
    });
  }

  async function getBranches(_request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getBranches({ projectPath: project }));
  }

  async function getRefs(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    const limit = validPositiveLimit(
      url.searchParams.get('limit'),
      GIT_REF_RESULT_LIMITS.default,
      GIT_REF_RESULT_LIMITS.max,
    );
    if (project instanceof Response) return project;
    if (limit === null) {
      return gitRouteError(`Invalid limit. Expected an integer between 1 and ${GIT_REF_RESULT_LIMITS.max}.`, 400);
    }
    return gitJson(git, () => git.getRefs({
      projectPath: project,
      query: url.searchParams.get('query') ?? undefined,
      limit,
      signal: request.signal,
    }));
  }

  async function postCheckout(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const ref = nonEmptyString(input.ref) ?? nonEmptyString(input.branch);
      const refKind = isGitRefKind(input.refKind) ? input.refKind : undefined;
      if (!project || !ref) {
        return gitRouteError('Missing required parameters: project and ref.', 400);
      }

      return git.checkout({ projectPath: project, ref, refKind });
    });
  }

  async function postCreateBranch(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const branch = nonEmptyString(input.branch);
      const baseRef = nonEmptyString(input.baseRef) ?? undefined;
      if (!project || !branch) {
        return gitRouteError('Missing required parameters: project and branch.', 400);
      }

      return git.createBranch({ projectPath: project, branch, baseRef });
    });
  }

  async function postHistoryCommits(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const ref = nonEmptyString(input.ref) ?? 'HEAD';
      const limit = validPositiveLimit(input.limit, 50, MAX_HISTORY_LIST_LIMIT);
      const offset = validNonNegativeInteger(input.offset, 0, MAX_HISTORY_OFFSET);

      if (!project) {
        return gitRouteError('Missing required parameter: project.', 400);
      }
      if (limit === null || offset === null) {
        return gitRouteError('Invalid history pagination parameters.', 400);
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
    });
  }

  async function postCommitSnapshot(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const commit = nonEmptyString(input.commit);
      const parent = nonEmptyString(input.parent);
      const context = validContextLines(input.context ?? 5);
      const bodyCandidateCount = validPositiveLimit(
        input.bodyCandidateCount,
        8,
        GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles,
      );

      if (!project || !commit) {
        return gitRouteError('Missing required parameters: project and commit.', 400);
      }
      if (context === null || bodyCandidateCount === null) {
        return gitRouteError('Invalid commit snapshot parameters.', 400);
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
    });
  }

  async function postCommitFiles(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const documentId = nonEmptyString(input.documentId);
      const commit = nonEmptyString(input.commit);
      const parent = nonEmptyString(input.parent);
      const context = validContextLines(input.context ?? 5);
      const files = stringArray(input.files);

      if (!project || !documentId || !commit || !files || files.length === 0) {
        return gitRouteError('Missing required parameters: project, documentId, commit, and files.', 400);
      }
      if (context === null) {
        return gitRouteError('Invalid context line count.', 400);
      }
      if (files.length > GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles) {
        return gitRouteError(`Too many files. Maximum is ${GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles}.`, 400);
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
    });
  }

  async function postGenerateCommitMessage(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const files = stringArray(input.files);
      if (!project || !files || files.length === 0) {
        return gitRouteError('Missing required parameters: project and files.', 400);
      }
      if (hasOwn(input, 'agentId') && !isAllowedGenerationAgent(agents, input.agentId)) {
        return gitRouteError('Invalid agent.', 400);
      }
      if (hasOwn(input, 'thinkingMode') && !isThinkingMode(input.thinkingMode)) {
        return gitRouteError('Invalid reasoning effort.', 400);
      }

      const generationSignal = createGenerationRequestSignal(request.signal);
      const persistedConfig = await resolveCommitMessageConfig(settings, agents, generationSignal);
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
      const useCommonDirPrefix = persistedConfig.useCommonDirPrefix === true;
      const thinkingMode = hasOwn(input, 'thinkingMode') && isThinkingMode(input.thinkingMode)
        ? input.thinkingMode
        : hasGenerationRoutingOverride(input)
          ? 'none'
          : persistedConfig.thinkingMode;

      const result = await git.generateCommitMessageForFiles({
        projectPath: project,
        files,
        agentId,
        model,
        apiProviderId,
        modelEndpointId,
        modelProtocol,
        thinkingMode,
        customPrompt,
        useCommonDirPrefix,
        signal: generationSignal,
      });
      return result;
    });
  }

  async function getRemoteStatus(_request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getRemoteStatus({ projectPath: project }));
  }

  async function postFetch(body: JsonBody): Promise<Response> {
    const project = requiredProjectFromBody(asJsonBody(body));
    if (project instanceof Response) return project;
    return gitJson(git, () => git.fetch({ projectPath: project }));
  }

  async function postPull(body: JsonBody): Promise<Response> {
    const project = requiredProjectFromBody(asJsonBody(body));
    if (project instanceof Response) return project;
    return gitJson(git, () => git.pull({ projectPath: project }));
  }

  async function postPush(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const remote = typeof input.remote === 'string' ? input.remote : undefined;
      const remoteBranch = typeof input.remoteBranch === 'string' ? input.remoteBranch : undefined;
      if (!project) {
        return gitRouteError('Missing required parameter: project.', 400);
      }

      return git.push({ projectPath: project, remote, remoteBranch });
    });
  }

  async function getRemotes(_request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getRemotes({ projectPath: project }));
  }

  async function postDiscard(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const file = nonEmptyString(input.file);
      if (!project || !file) {
        return gitRouteError('Missing required parameters: project and file.', 400);
      }

      return git.discard({ projectPath: project, file });
    });
  }

  async function postDeleteUntracked(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const file = nonEmptyString(input.file);
      if (!project || !file) {
        return gitRouteError('Missing required parameters: project and file.', 400);
      }

      return git.deleteUntracked({ projectPath: project, file });
    });
  }

  async function postWorkbenchSnapshot(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const mode = validMode(input.mode);
      const context = validContextLines(input.context ?? 5);
      const selectedFile = nonEmptyString(input.selectedFile);
      const bodyCandidateCount = validPositiveLimit(
        input.bodyCandidateCount,
        8,
        GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles,
      );

      if (!project) {
        return gitRouteError('Missing required parameter: project.', 400);
      }
      if (!mode) {
        return gitRouteError('Invalid mode. Expected one of: working, staged.', 400);
      }
      if (context === null) {
        return gitRouteError(`Invalid context. Expected an integer between 0 and ${GIT_DIFF_LIMITS.maxContextLines}.`, 400);
      }
      if (bodyCandidateCount === null) {
        return gitRouteError('Invalid bodyCandidateCount.', 400);
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
    });
  }

  async function postWorkingTreeFingerprint(body: JsonBody, request: Request): Promise<Response> {
    const project = requiredProjectFromBody(asJsonBody(body));
    if (project instanceof Response) return project;

    return gitJson(git, async () => {
      const trace: GitCommandTrace[] = [];
      const startedAt = performance.now();
      const result = await git.getWorkingTreeFingerprint({
        projectPath: project,
        trace,
        signal: request.signal,
      });
      return traceJsonResponse('working-tree-fingerprint', startedAt, trace, result);
    });
  }

  async function postQuickSummary(body: JsonBody, request: Request): Promise<Response> {
    const project = requiredProjectFromBody(asJsonBody(body));
    if (project instanceof Response) return project;

    return gitJson(git, async () => {
      const trace: GitCommandTrace[] = [];
      const startedAt = performance.now();
      const result = await git.getQuickSummary({
        projectPath: project,
        trace,
        signal: request.signal,
      });
      return traceJsonResponse('quick-summary', startedAt, trace, result);
    });
  }

  async function postReviewDocumentFiles(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const documentId = nonEmptyString(input.documentId);
      const files = stringArray(input.files);
      const mode = validMode(input.mode);
      const context = validContextLines(input.context ?? 5);

      if (!project || !documentId || !files || files.length === 0) {
        return gitRouteError('Missing required parameters: project, documentId, and files.', 400);
      }
      if (!mode) {
        return gitRouteError('Invalid mode. Expected one of: working, staged.', 400);
      }
      if (context === null) {
        return gitRouteError(`Invalid context. Expected an integer between 0 and ${GIT_DIFF_LIMITS.maxContextLines}.`, 400);
      }
      if (files.length > GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles) {
        return gitRouteError(`Too many files. Maximum is ${GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles}.`, 400);
      }

      const result = await git.getReviewFileBodies({
        projectPath: project,
        documentId,
        files,
        mode,
        context,
        signal: request.signal,
      });
      return result;
    });
  }

  async function postStageSelection(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const file = nonEmptyString(input.file);
      const modeRaw = input.mode;
      const mode = validStageMode(modeRaw);
      const selectionRaw = input.selection;
      const selection = validSelection(selectionRaw);
      const contextLines = input.contextLines;

      if (!project || !file || !modeRaw || !selectionRaw) {
        return gitRouteError('Missing required parameters: project, file, mode, and selection.lineIndices.', 400);
      }
      if (!mode) {
        return gitRouteError('Invalid mode. Expected one of: stage, unstage.', 400);
      }
      if (!selection) {
        return gitRouteError('selection.lineIndices must be an array of non-negative integers.', 400);
      }

      const result = await git.stageSelection({
        projectPath: project, file, mode, selection,
        contextLines: typeof contextLines === 'number' ? contextLines : 5,
      });
      return result;
    });
  }

  async function postStageHunk(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const file = nonEmptyString(input.file);
      const modeRaw = input.mode;
      const mode = validStageMode(modeRaw);
      const hunkIndex = input.hunkIndex;
      const contextLines = input.contextLines;

      if (!project || !file || !modeRaw || hunkIndex === undefined) {
        return gitRouteError('Missing required parameters: project, file, mode, and hunkIndex.', 400);
      }
      if (!mode) {
        return gitRouteError('Invalid mode. Expected one of: stage, unstage.', 400);
      }
      if (!isNonNegativeInteger(hunkIndex)) {
        return gitRouteError('hunkIndex must be a non-negative integer.', 400);
      }

      const result = await git.stageHunk({
        projectPath: project, file, mode, hunkIndex,
        contextLines: typeof contextLines === 'number' ? contextLines : 5,
      });
      return result;
    });
  }

  async function getWorktrees(_request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getWorktrees({ projectPath: project }));
  }

  async function getTargets(_request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getTargetCandidates({ projectPath: project }));
  }

  async function postCreateWorktree(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const baseRef = typeof input.baseRef === 'string' ? input.baseRef : undefined;
      const worktreePath = nonEmptyString(input.worktreePath);
      const branch = typeof input.branch === 'string' ? input.branch : undefined;
      const detach = input.detach === true;

      if (!project || !worktreePath) {
        return gitRouteError('Missing required parameters: project and worktreePath.', 400);
      }

      return git.createWorktree({ projectPath: project, baseRef, worktreePath, branch, detach });
    });
  }

  async function postRemoveWorktree(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const worktreePath = nonEmptyString(input.worktreePath);
      const force = input.force === true;

      if (!project || !worktreePath) {
        return gitRouteError('Missing required parameters: project and worktreePath.', 400);
      }

      return git.removeWorktree({ projectPath: project, worktreePath, force });
    });
  }

  async function postCommitIndex(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const message = nonEmptyString(input.message);

      if (!project || !message) {
        return gitRouteError('Missing required parameters: project and message.', 400);
      }

      return git.commitIndex({ projectPath: project, message });
    });
  }

  async function postStagePaths(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const hasPaths = hasOwn(input, 'paths');
      const paths = stringArray(input.paths);
      const modeRaw = input.mode;
      const mode = validStageMode(modeRaw);

      if (!project || !hasPaths || !modeRaw) {
        return gitRouteError('Missing required parameters: project, paths, and mode.', 400);
      }
      if (!paths || paths.length === 0) {
        return gitRouteError('Invalid paths. Expected a non-empty array of non-empty strings.', 400);
      }
      if (!mode) {
        return gitRouteError('Invalid mode. Expected one of: stage, unstage.', 400);
      }
      if (paths.some((path) => path.includes('\0'))) {
        return gitRouteError('Invalid paths. Pathspecs cannot contain NUL bytes.', 400);
      }

      return git.stagePaths({ projectPath: project, paths, mode });
    });
  }

  async function postRevertCommit(body: JsonBody): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const commit = nonEmptyString(input.commit);

      if (!project || !commit) {
        return gitRouteError('Missing required parameters: project and commit.', 400);
      }

      return git.revertCommit({ projectPath: project, commit });
    });
  }

  async function getConflicts(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getConflicts({ projectPath: project, signal: request.signal }));
  }

  async function getConflictDetails(request: Request, url: URL): Promise<Response> {
    const input = requiredQueryStrings(url, ['project', 'file'], 'Missing required parameters: project and file.');
    if (input instanceof Response) return input;
    return gitJson(git, () => git.getConflictDetails({
      projectPath: input.project,
      file: input.file,
      signal: request.signal,
    }));
  }

  async function postAcceptConflictSide(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const file = nonEmptyString(input.file);
      const side = input.side;
      if (!project || !file || (side !== 'ours' && side !== 'theirs')) {
        return gitRouteError('Missing or invalid parameters: project, file, and side.', 400);
      }
      const result = await git.acceptConflictSide({
        projectPath: project,
        file,
        side,
        signal: request.signal,
      });
      return result;
    });
  }

  async function postMarkConflictResolved(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const file = nonEmptyString(input.file);
      if (!project || !file) {
        return gitRouteError('Missing required parameters: project and file.', 400);
      }
      return git.markConflictResolved({ projectPath: project, file, signal: request.signal });
    });
  }

  async function getStashes(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getStashes({ projectPath: project, signal: request.signal }));
  }

  async function postCreateStash(body: JsonBody, request: Request): Promise<Response> {
    const input = asJsonBody(body);
    const project = requiredProjectFromBody(input);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.createStash({
      projectPath: project,
      message: typeof input.message === 'string' ? input.message : undefined,
      includeUntracked: input.includeUntracked === true,
      signal: request.signal,
    }));
  }

  async function postApplyStash(body: JsonBody, request: Request): Promise<Response> {
    const input = asJsonBody(body);
    const project = nonEmptyString(input.project);
    const stashRef = nonEmptyString(input.stashRef);
    if (!project || !stashRef) {
      return gitRouteError('Missing required parameters: project and stashRef.', 400);
    }
    return gitJson(git, () => git.applyStash({ projectPath: project, stashRef, signal: request.signal }));
  }

  async function postPopStash(body: JsonBody, request: Request): Promise<Response> {
    const input = asJsonBody(body);
    const project = nonEmptyString(input.project);
    const stashRef = nonEmptyString(input.stashRef);
    if (!project || !stashRef) {
      return gitRouteError('Missing required parameters: project and stashRef.', 400);
    }
    return gitJson(git, () => git.popStash({ projectPath: project, stashRef, signal: request.signal }));
  }

  async function postDropStash(body: JsonBody, request: Request): Promise<Response> {
    const input = asJsonBody(body);
    const project = nonEmptyString(input.project);
    const stashRef = nonEmptyString(input.stashRef);
    if (!project || !stashRef) {
      return gitRouteError('Missing required parameters: project and stashRef.', 400);
    }
    return gitJson(git, () => git.dropStash({ projectPath: project, stashRef, signal: request.signal }));
  }

  async function getFileHistory(request: Request, url: URL): Promise<Response> {
    const input = requiredQueryStrings(url, ['project', 'file'], 'Missing required parameters: project and file.');
    const limit = validPositiveLimit(url.searchParams.get('limit'), 50, 200);
    if (input instanceof Response) return input;
    if (limit === null) {
      return gitRouteError('Invalid limit. Expected an integer between 1 and 200.', 400);
    }
    return gitJson(git, () => git.getFileHistory({
        projectPath: input.project,
        file: input.file,
        limit,
        signal: request.signal,
    }));
  }

  async function getBlame(request: Request, url: URL): Promise<Response> {
    const input = requiredQueryStrings(url, ['project', 'file'], 'Missing required parameters: project and file.');
    const limit = validPositiveLimit(url.searchParams.get('limit'), 2000, 2000);
    const ref = url.searchParams.get('ref') || 'HEAD';
    if (input instanceof Response) return input;
    if (limit === null) {
      return gitRouteError('Invalid limit. Expected an integer between 1 and 2000.', 400);
    }
    return gitJson(git, () => git.getBlame({
      projectPath: input.project,
      file: input.file,
      ref,
      limit,
      signal: request.signal,
    }));
  }

  async function getGraph(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    const limit = validPositiveLimit(url.searchParams.get('limit'), 200, 500);
    if (project instanceof Response) return project;
    if (limit === null) {
      return gitRouteError('Invalid limit. Expected an integer between 1 and 500.', 400);
    }
    return gitJson(git, () => git.getGraph({ projectPath: project, limit, signal: request.signal }));
  }

  async function getCompare(request: Request, url: URL): Promise<Response> {
    const input = requiredQueryStrings(
      url,
      ['project', 'base', 'head'],
      'Missing required parameters: project, base, and head.',
    );
    if (input instanceof Response) return input;
    return gitJson(git, () =>
      git.getCompare({
        projectPath: input.project,
        base: input.base,
        head: input.head,
        signal: request.signal,
      }),
    );
  }

  return {
    '/api/v1/git/status': { GET: getStatus },
    '/api/v1/git/diff': { GET: getDiff },
    '/api/v1/git/file-with-diff': { GET: getFileWithDiff },
    '/api/v1/git/initial-commit': { POST: withJsonBody(postInitialCommit) },
    '/api/v1/git/commit': { POST: withJsonBody(postCommit) },
    '/api/v1/git/branches': { GET: getBranches },
    '/api/v1/git/refs': { GET: getRefs },
    '/api/v1/git/checkout': { POST: withJsonBody(postCheckout) },
    '/api/v1/git/create-branch': { POST: withJsonBody(postCreateBranch) },
    '/api/v1/git/history/commits': { POST: withJsonBody(postHistoryCommits) },
    '/api/v1/git/history/commit/snapshot': { POST: withJsonBody(postCommitSnapshot) },
    '/api/v1/git/history/commit/files': { POST: withJsonBody(postCommitFiles) },
    ...createGitComparisonRoutes(git),
    '/api/v1/git/generate-commit-message': { POST: withJsonBody(postGenerateCommitMessage) },
    '/api/v1/git/remote-status': { GET: getRemoteStatus },
    '/api/v1/git/fetch': { POST: withJsonBody(postFetch) },
    '/api/v1/git/pull': { POST: withJsonBody(postPull) },
    '/api/v1/git/push': { POST: withJsonBody(postPush) },
    '/api/v1/git/remotes': { GET: getRemotes },
    '/api/v1/git/discard': { POST: withJsonBody(postDiscard) },
    '/api/v1/git/delete-untracked': { POST: withJsonBody(postDeleteUntracked) },
    '/api/v1/git/workbench/snapshot': { POST: withJsonBody(postWorkbenchSnapshot) },
    '/api/v1/git/workbench/fingerprint': { POST: withJsonBody(postWorkingTreeFingerprint) },
    '/api/v1/git/working-tree/fingerprint': { POST: withJsonBody(postWorkingTreeFingerprint) },
    '/api/v1/git/quick-summary': { POST: withJsonBody(postQuickSummary) },
    '/api/v1/git/review-document/files': { POST: withJsonBody(postReviewDocumentFiles) },
    '/api/v1/git/stage-selection': { POST: withJsonBody(postStageSelection) },
    '/api/v1/git/stage-hunk': { POST: withJsonBody(postStageHunk) },
    '/api/v1/git/worktrees': { GET: getWorktrees },
    '/api/v1/git/targets': { GET: getTargets },
    '/api/v1/git/worktrees/create': { POST: withJsonBody(postCreateWorktree) },
    '/api/v1/git/worktrees/remove': { POST: withJsonBody(postRemoveWorktree) },
    '/api/v1/git/revert-commit': { POST: withJsonBody(postRevertCommit) },
    '/api/v1/git/commit-index': { POST: withJsonBody(postCommitIndex) },
    '/api/v1/git/stage-paths': { POST: withJsonBody(postStagePaths) },
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
