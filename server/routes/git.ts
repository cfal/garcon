import { createGitRouteService, type GitRouteService, type GitServiceResolver } from './git-node-service.js';
import { createGitGenerationRoute } from './git-generation.js';
import { gitJsonBody, gitQuery } from './git-request-fields.js';
import { isGitDocumentRef } from '../../common/git-request-validation.js';
import { GIT_OPERATION_TIMEOUT_MS } from '../../common/git-execution.js';
import {
  GIT_DIFF_LIMITS,
  GIT_REF_RESULT_LIMITS,
  GIT_REVIEW_DOCUMENT_LIMITS,
  type GitCommandTrace,
  type GitRefKind,
  type GitReviewRouteMetrics,
} from '../git/types.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { SettingsStore } from '../settings/store.js';
import { isRecord } from '../../common/json.js';
import { isGitRefKind, parseGitRefSort } from '../../common/git-refs.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import { asJsonBody, type JsonBody } from './route-helpers.js';
import { createGitComparisonRoutes } from './git-comparisons.js';
import { measureGitRoutePhase, traceGitJsonResponse } from './git-route-response.js';

type GitMode = 'working' | 'staged';
type StageMode = 'stage' | 'unstage';

const MAX_HISTORY_LIST_LIMIT = 200;
const MAX_HISTORY_OFFSET = 100_000;

interface StageSelectionInput {
  lineIndices: number[];
}

function hasOwn(source: unknown, key: string): source is Record<string, unknown> {
  return Boolean(source) && Object.prototype.hasOwnProperty.call(source, key);
}

function validReviewBodyPurpose(value: unknown): 'visible' | 'prefetch' | null {
  return value === 'visible' || value === 'prefetch' ? value : null;
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

function validNonNegativeInteger(value: unknown, fallback: number, max: number): number | null {
  const next = value === null || value === undefined ? fallback : Number(value);
  if (!Number.isInteger(next) || next < 0 || next > max) return null;
  return next;
}

type GitRouteResult = Response | unknown;

async function gitJson(git: GitRouteService, action: () => Promise<GitRouteResult> | GitRouteResult): Promise<Response> {
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

export default function createGitRoutes(agents: AgentRegistryServiceContract, settings: SettingsStore, resolveGit: GitServiceResolver, timeoutMs = GIT_OPERATION_TIMEOUT_MS): RouteMap {
  const git = createGitRouteService(resolveGit, timeoutMs);

  async function getStatus(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getStatus({ nodeId: url.searchParams.get('nodeId'), signal: request.signal, projectPath: project }));
  }

  async function postInitialCommit(body: JsonBody, request: Request): Promise<Response> {
    const project = requiredProjectFromBody(asJsonBody(body));
    if (project instanceof Response) return project;
    return gitJson(git, () => git.initialCommit({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project }));
  }

  async function postCommit(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const message = nonEmptyString(input.message);
      const files = stringArray(input.files);
      if (!project || !message || !files || files.length === 0) {
        return gitRouteError('Missing required parameters: project, message, and files.', 400);
      }

      return git.commit({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project, message, files });
    });
  }

  async function getBranches(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getBranches({ nodeId: url.searchParams.get('nodeId'), signal: request.signal, projectPath: project }));
  }

  async function getRefs(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    const limit = validPositiveLimit(url.searchParams.get('limit'), GIT_REF_RESULT_LIMITS.default, GIT_REF_RESULT_LIMITS.max);
    const sort = parseGitRefSort(
      url.searchParams.get('sort'),
      url.searchParams.get('direction'),
    );
    if (project instanceof Response) return project;
    if (limit === null) {
      return gitRouteError(`Invalid limit. Expected an integer between 1 and ${GIT_REF_RESULT_LIMITS.max}.`, 400);
    }
    if (!sort) {
      return gitRouteError(
        'Invalid ref sort. Expected sort=name|updated and direction=asc|desc together.',
        400,
      );
    }
    return gitJson(git, () =>
      git.getRefs({ nodeId: url.searchParams.get('nodeId'),
        projectPath: project,
        query: url.searchParams.get('query') ?? undefined,
        limit,
        sort,
        signal: request.signal,
      }),
    );
  }

  async function postCheckout(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const ref = nonEmptyString(input.ref) ?? nonEmptyString(input.branch);
      const refKind = isGitRefKind(input.refKind) ? input.refKind : undefined;
      if (!project || !ref) {
        return gitRouteError('Missing required parameters: project and ref.', 400);
      }

      return git.checkout({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project, ref, refKind });
    });
  }

  async function postCreateBranch(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const branch = nonEmptyString(input.branch);
      const baseRef = nonEmptyString(input.baseRef) ?? undefined;
      if (!project || !branch) {
        return gitRouteError('Missing required parameters: project and branch.', 400);
      }

      return git.createBranch({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project, branch, baseRef });
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
      const result = await git.getHistoryCommits({ nodeId: asJsonBody(body).nodeId,
        projectPath: project,
        ref,
        limit,
        offset,
        trace,
        signal: request.signal,
      });
      return traceGitJsonResponse('history-commits', startedAt, trace, result);
    });
  }

  async function postCommitSnapshot(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const commit = nonEmptyString(input.commit);
      const parent = nonEmptyString(input.parent);
      const context = validContextLines(input.context ?? 5);
      const bodyCandidateCount = validPositiveLimit(input.bodyCandidateCount, 8, GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles);

      if (!project || !commit) {
        return gitRouteError('Missing required parameters: project and commit.', 400);
      }
      if (context === null || bodyCandidateCount === null) {
        return gitRouteError('Invalid commit snapshot parameters.', 400);
      }

      const trace: GitCommandTrace[] = [];
      const metrics: GitReviewRouteMetrics = { phases: [] };
      const startedAt = performance.now();
      const result = await measureGitRoutePhase(metrics.phases, 'summary-git', () =>
        git.getCommitSnapshot({ nodeId: asJsonBody(body).nodeId,
          projectPath: project,
          commit,
          parent,
          context,
          bodyCandidateCount,
          trace,
          metrics,
          signal: request.signal,
        }));
      if (result.status === 'ready') {
        metrics.fileCount = result.files.length;
        metrics.rowCount = result.files.reduce((total, file) => total + file.estimatedRows, 0);
      }
      return traceGitJsonResponse('history-commit-snapshot', startedAt, trace, result, metrics);
    });
  }

  async function getRemoteStatus(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getRemoteStatus({ nodeId: url.searchParams.get('nodeId'), signal: request.signal, projectPath: project }));
  }

  async function postFetch(body: JsonBody, request: Request): Promise<Response> {
    const project = requiredProjectFromBody(asJsonBody(body));
    if (project instanceof Response) return project;
    return gitJson(git, () => git.fetch({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project }));
  }

  async function postPull(body: JsonBody, request: Request): Promise<Response> {
    const project = requiredProjectFromBody(asJsonBody(body));
    if (project instanceof Response) return project;
    return gitJson(git, () => git.pull({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project }));
  }

  async function postPush(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const remote = typeof input.remote === 'string' ? input.remote : undefined;
      const remoteBranch = typeof input.remoteBranch === 'string' ? input.remoteBranch : undefined;
      if (!project) {
        return gitRouteError('Missing required parameter: project.', 400);
      }

      return git.push({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project, remote, remoteBranch });
    });
  }

  async function getRemotes(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getRemotes({ nodeId: url.searchParams.get('nodeId'), signal: request.signal, projectPath: project }));
  }

  async function postDiscard(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const file = nonEmptyString(input.file);
      if (!project || !file) {
        return gitRouteError('Missing required parameters: project and file.', 400);
      }

      return git.discard({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project, file });
    });
  }

  async function postDeleteUntracked(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const file = nonEmptyString(input.file);
      if (!project || !file) {
        return gitRouteError('Missing required parameters: project and file.', 400);
      }

      return git.deleteUntracked({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project, file });
    });
  }

  async function postWorkbenchSnapshot(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const mode = validMode(input.mode);
      const context = validContextLines(input.context ?? 5);
      const selectedFile = nonEmptyString(input.selectedFile);
      const bodyCandidateCount = validPositiveLimit(input.bodyCandidateCount, 8, GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles);

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
      const metrics: GitReviewRouteMetrics = { phases: [] };
      const startedAt = performance.now();
      const result = await measureGitRoutePhase(metrics.phases, 'summary-git', () =>
        git.getWorkbenchSnapshot({ nodeId: asJsonBody(body).nodeId,
          projectPath: project,
          mode,
          context,
          selectedFile,
          bodyCandidateCount,
          trace,
          metrics,
          signal: request.signal,
        }));
      if (result.status === 'ready') {
        metrics.fileCount = result.reviewSummary.files.length;
        metrics.rowCount = result.reviewSummary.files.reduce(
          (total, file) => total + file.estimatedRows,
          0,
        );
      }
      return traceGitJsonResponse('workbench-snapshot', startedAt, trace, result, metrics);
    });
  }

  async function postWorkingTreeFingerprint(body: JsonBody, request: Request): Promise<Response> {
    const project = requiredProjectFromBody(asJsonBody(body));
    if (project instanceof Response) return project;

    return gitJson(git, async () => {
      const trace: GitCommandTrace[] = [];
      const startedAt = performance.now();
      const result = await git.getWorkingTreeFingerprint({ nodeId: asJsonBody(body).nodeId,
        projectPath: project,
        trace,
        signal: request.signal,
      });
      return traceGitJsonResponse('working-tree-fingerprint', startedAt, trace, result);
    });
  }

  async function postQuickSummary(body: JsonBody, request: Request): Promise<Response> {
    const project = requiredProjectFromBody(asJsonBody(body));
    if (project instanceof Response) return project;

    return gitJson(git, async () => {
      const trace: GitCommandTrace[] = [];
      const startedAt = performance.now();
      const result = await git.getQuickSummary({ nodeId: asJsonBody(body).nodeId,
        projectPath: project,
        trace,
        signal: request.signal,
      });
      return traceGitJsonResponse('quick-summary', startedAt, trace, result);
    });
  }

  async function postReviewDocumentFiles(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const document = isGitDocumentRef(input.document) ? input.document : null;
      const files = stringArray(input.files);
      const purpose = validReviewBodyPurpose(input.purpose);

      if (!project || !document || !files || files.length === 0 || !purpose) {
        return gitRouteError(
          'Missing or invalid parameters: project, document, files, and purpose.',
          400,
        );
      }
      if (files.length > GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles) {
        return gitRouteError(`Too many files. Maximum is ${GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles}.`, 400);
      }

      const trace: GitCommandTrace[] = [];
      const metrics: GitReviewRouteMetrics = { phases: [] };
      const startedAt = performance.now();
      const result = await git.getReviewDocumentFileBodies({ nodeId: asJsonBody(body).nodeId,
        projectPath: project,
        document,
        files,
        purpose,
        trace,
        metrics,
        signal: request.signal,
      });
      return traceGitJsonResponse('review-document-files', startedAt, trace, result, metrics);
    });
  }

  async function postStageSelection(body: JsonBody, request: Request): Promise<Response> {
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


      if (!isGitDocumentRef(input.document) || typeof input.bodyFingerprint !== 'string' || typeof input.patchDigest !== 'string') {
        return gitRouteError('A current review document and patch identity are required.', 400);
      }
      const result = await git.stageSelection({ nodeId: asJsonBody(body).nodeId, signal: request.signal,
        document: input.document, bodyFingerprint: input.bodyFingerprint, patchDigest: input.patchDigest,
        projectPath: project,
        file,
        mode,
        selection,
        contextLines: typeof contextLines === 'number' ? contextLines : 5,
      });
      return result;
    });
  }

  async function postStageHunk(body: JsonBody, request: Request): Promise<Response> {
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


      if (!isGitDocumentRef(input.document) || typeof input.bodyFingerprint !== 'string' || typeof input.patchDigest !== 'string') {
        return gitRouteError('A current review document and patch identity are required.', 400);
      }
      const result = await git.stageHunk({ nodeId: asJsonBody(body).nodeId, signal: request.signal,
        document: input.document, bodyFingerprint: input.bodyFingerprint, patchDigest: input.patchDigest,
        projectPath: project,
        file,
        mode,
        hunkIndex,
        contextLines: typeof contextLines === 'number' ? contextLines : 5,
      });
      return result;
    });
  }

  async function getWorktrees(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getWorktrees({ nodeId: url.searchParams.get('nodeId'), signal: request.signal, projectPath: project }));
  }

  async function getTargets(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getTargetCandidates({ nodeId: url.searchParams.get('nodeId'), signal: request.signal, projectPath: project }));
  }

  async function postCreateWorktree(body: JsonBody, request: Request): Promise<Response> {
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

      return git.createWorktree({ nodeId: asJsonBody(body).nodeId, signal: request.signal,
        projectPath: project,
        baseRef,
        worktreePath,
        branch,
        detach,
      });
    });
  }

  async function postRemoveWorktree(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const worktreePath = nonEmptyString(input.worktreePath);
      const force = input.force === true;

      if (!project || !worktreePath) {
        return gitRouteError('Missing required parameters: project and worktreePath.', 400);
      }

      return git.removeWorktree({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project, worktreePath, force });
    });
  }

  async function postCommitIndex(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const message = nonEmptyString(input.message);

      if (!project || !message) {
        return gitRouteError('Missing required parameters: project and message.', 400);
      }

      return git.commitIndex({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project, message });
    });
  }

  async function postStagePaths(body: JsonBody, request: Request): Promise<Response> {
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

      return git.stagePaths({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project, paths, mode });
    });
  }

  async function postRevertCommit(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const commit = nonEmptyString(input.commit);

      if (!project || !commit) {
        return gitRouteError('Missing required parameters: project and commit.', 400);
      }

      return git.revertCommit({ nodeId: asJsonBody(body).nodeId, signal: request.signal, projectPath: project, commit });
    });
  }

  async function getConflicts(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getConflicts({ nodeId: url.searchParams.get('nodeId'), projectPath: project, signal: request.signal }));
  }

  async function getConflictDetails(request: Request, url: URL): Promise<Response> {
    const input = requiredQueryStrings(url, ['project', 'file'], 'Missing required parameters: project and file.');
    if (input instanceof Response) return input;
    return gitJson(git, () =>
      git.getConflictDetails({ nodeId: url.searchParams.get('nodeId'),
        projectPath: input.project,
        file: input.file,
        signal: request.signal,
      }),
    );
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
      const result = await git.acceptConflictSide({ nodeId: asJsonBody(body).nodeId,
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
      return git.markConflictResolved({ nodeId: asJsonBody(body).nodeId,
        projectPath: project,
        file,
        signal: request.signal,
      });
    });
  }

  async function getStashes(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    if (project instanceof Response) return project;
    return gitJson(git, () => git.getStashes({ nodeId: url.searchParams.get('nodeId'), projectPath: project, signal: request.signal }));
  }

  async function postCreateStash(body: JsonBody, request: Request): Promise<Response> {
    const input = asJsonBody(body);
    const project = requiredProjectFromBody(input);
    if (project instanceof Response) return project;
    return gitJson(git, () =>
      git.createStash({ nodeId: asJsonBody(body).nodeId,
        projectPath: project,
        message: typeof input.message === 'string' ? input.message : undefined,
        includeUntracked: input.includeUntracked === true,
        signal: request.signal,
      }),
    );
  }

  async function postApplyStash(body: JsonBody, request: Request): Promise<Response> {
    const input = asJsonBody(body);
    const project = nonEmptyString(input.project);
    const stashRef = nonEmptyString(input.stashRef);
    if (!project || !stashRef) {
      return gitRouteError('Missing required parameters: project and stashRef.', 400);
    }
    return gitJson(git, () =>
      git.applyStash({ nodeId: asJsonBody(body).nodeId,
        projectPath: project,
        stashRef,
        signal: request.signal,
      }),
    );
  }

  async function postPopStash(body: JsonBody, request: Request): Promise<Response> {
    const input = asJsonBody(body);
    const project = nonEmptyString(input.project);
    const stashRef = nonEmptyString(input.stashRef);
    if (!project || !stashRef) {
      return gitRouteError('Missing required parameters: project and stashRef.', 400);
    }
    return gitJson(git, () => git.popStash({ nodeId: asJsonBody(body).nodeId, projectPath: project, stashRef, signal: request.signal }));
  }

  async function postDropStash(body: JsonBody, request: Request): Promise<Response> {
    const input = asJsonBody(body);
    const project = nonEmptyString(input.project);
    const stashRef = nonEmptyString(input.stashRef);
    if (!project || !stashRef) {
      return gitRouteError('Missing required parameters: project and stashRef.', 400);
    }
    return gitJson(git, () => git.dropStash({ nodeId: asJsonBody(body).nodeId, projectPath: project, stashRef, signal: request.signal }));
  }

  async function getFileHistory(request: Request, url: URL): Promise<Response> {
    const input = requiredQueryStrings(url, ['project', 'file'], 'Missing required parameters: project and file.');
    const limit = validPositiveLimit(url.searchParams.get('limit'), 50, 200);
    if (input instanceof Response) return input;
    if (limit === null) {
      return gitRouteError('Invalid limit. Expected an integer between 1 and 200.', 400);
    }
    return gitJson(git, () =>
      git.getFileHistory({ nodeId: url.searchParams.get('nodeId'),
        projectPath: input.project,
        file: input.file,
        limit,
        signal: request.signal,
      }),
    );
  }

  async function getBlame(request: Request, url: URL): Promise<Response> {
    const input = requiredQueryStrings(url, ['project', 'file'], 'Missing required parameters: project and file.');
    const limit = validPositiveLimit(url.searchParams.get('limit'), 2000, 2000);
    const ref = url.searchParams.get('ref') || 'HEAD';
    if (input instanceof Response) return input;
    if (limit === null) {
      return gitRouteError('Invalid limit. Expected an integer between 1 and 2000.', 400);
    }
    return gitJson(git, () =>
      git.getBlame({ nodeId: url.searchParams.get('nodeId'),
        projectPath: input.project,
        file: input.file,
        ref,
        limit,
        signal: request.signal,
      }),
    );
  }

  async function getGraph(request: Request, url: URL): Promise<Response> {
    const project = requiredProjectFromQuery(url);
    const limit = validPositiveLimit(url.searchParams.get('limit'), 200, 500);
    if (project instanceof Response) return project;
    if (limit === null) {
      return gitRouteError('Invalid limit. Expected an integer between 1 and 500.', 400);
    }
    return gitJson(git, () => git.getGraph({ nodeId: url.searchParams.get('nodeId'), projectPath: project, limit, signal: request.signal }));
  }

  return {
    '/api/v1/git/status': { GET: gitQuery('getStatus', getStatus) },
    '/api/v1/git/initial-commit': { POST: gitJsonBody('initialCommit', postInitialCommit) },
    '/api/v1/git/commit': { POST: gitJsonBody('commit', postCommit) },
    '/api/v1/git/branches': { GET: gitQuery('getBranches', getBranches) },
    '/api/v1/git/refs': { GET: gitQuery('getRefs', getRefs) },
    '/api/v1/git/checkout': { POST: gitJsonBody('checkout', postCheckout) },
    '/api/v1/git/create-branch': { POST: gitJsonBody('createBranch', postCreateBranch) },
    '/api/v1/git/history/commits': { POST: gitJsonBody('getHistoryCommits', postHistoryCommits) },
    '/api/v1/git/history/commit/snapshot': {
      POST: gitJsonBody('getCommitSnapshot', postCommitSnapshot),
    },
    ...createGitComparisonRoutes(git),
    '/api/v1/git/generate-commit-message': {
      POST: createGitGenerationRoute(agents, settings, resolveGit),
    },
    '/api/v1/git/remote-status': { GET: gitQuery('getRemoteStatus', getRemoteStatus) },
    '/api/v1/git/fetch': { POST: gitJsonBody('fetch', postFetch) },
    '/api/v1/git/pull': { POST: gitJsonBody('pull', postPull) },
    '/api/v1/git/push': { POST: gitJsonBody('push', postPush) },
    '/api/v1/git/remotes': { GET: gitQuery('getRemotes', getRemotes) },
    '/api/v1/git/discard': { POST: gitJsonBody('discard', postDiscard) },
    '/api/v1/git/delete-untracked': { POST: gitJsonBody('deleteUntracked', postDeleteUntracked) },
    '/api/v1/git/workbench/snapshot': {
      POST: gitJsonBody('getWorkbenchSnapshot', postWorkbenchSnapshot),
    },
    '/api/v1/git/working-tree/fingerprint': {
      POST: gitJsonBody('getWorkingTreeFingerprint', postWorkingTreeFingerprint),
    },
    '/api/v1/git/quick-summary': { POST: gitJsonBody('getQuickSummary', postQuickSummary) },
    '/api/v1/git/review-documents/files': {
      POST: gitJsonBody('getReviewDocumentFileBodies', postReviewDocumentFiles),
    },
    '/api/v1/git/stage-selection': { POST: gitJsonBody('stageSelection', postStageSelection) },
    '/api/v1/git/stage-hunk': { POST: gitJsonBody('stageHunk', postStageHunk) },
    '/api/v1/git/worktrees': { GET: gitQuery('getWorktrees', getWorktrees) },
    '/api/v1/git/targets': { GET: gitQuery('getTargetCandidates', getTargets) },
    '/api/v1/git/worktrees/create': { POST: gitJsonBody('createWorktree', postCreateWorktree) },
    '/api/v1/git/worktrees/remove': { POST: gitJsonBody('removeWorktree', postRemoveWorktree) },
    '/api/v1/git/revert-commit': { POST: gitJsonBody('revertCommit', postRevertCommit) },
    '/api/v1/git/commit-index': { POST: gitJsonBody('commitIndex', postCommitIndex) },
    '/api/v1/git/stage-paths': { POST: gitJsonBody('stagePaths', postStagePaths) },
    '/api/v1/git/conflicts': { GET: gitQuery('getConflicts', getConflicts) },
    '/api/v1/git/conflict-details': { GET: gitQuery('getConflictDetails', getConflictDetails) },
    '/api/v1/git/conflict/accept': {
      POST: gitJsonBody('acceptConflictSide', postAcceptConflictSide),
    },
    '/api/v1/git/conflict/resolve': {
      POST: gitJsonBody('markConflictResolved', postMarkConflictResolved),
    },
    '/api/v1/git/stashes': { GET: gitQuery('getStashes', getStashes) },
    '/api/v1/git/stash/create': { POST: gitJsonBody('createStash', postCreateStash) },
    '/api/v1/git/stash/apply': { POST: gitJsonBody('applyStash', postApplyStash) },
    '/api/v1/git/stash/pop': { POST: gitJsonBody('popStash', postPopStash) },
    '/api/v1/git/stash/drop': { POST: gitJsonBody('dropStash', postDropStash) },
    '/api/v1/git/file-history': { GET: gitQuery('getFileHistory', getFileHistory) },
    '/api/v1/git/blame': { GET: gitQuery('getBlame', getBlame) },
    '/api/v1/git/graph': { GET: gitQuery('getGraph', getGraph) },
  };
}
