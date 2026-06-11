import { createGitService } from '../git/git-service.js';
import { classifyGitError } from '../git/git-error-classifier.js';
import { resolveEffectiveGenerationUiConfig } from '../settings/generation-effective.js';
import { resolveGenerationContext } from '../settings/generation-config-source.ts';
import { isAgentId } from '../../common/agents.ts';
import { withJsonBody } from '../lib/json-route.js';
import {
  assertWithinProjectBase,
  isProjectBoundaryError,
  projectBoundaryErrorResponse,
} from '../lib/path-boundary.ts';

function hasOwn(source, key) {
  return Boolean(source) && Object.prototype.hasOwnProperty.call(source, key);
}

function optionalId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(value) ? value : null;
}

function optionalProtocol(value) {
  return value === 'openai-compatible' || value === 'anthropic-messages' ? value : null;
}

function isAllowedGenerationAgent(agents, value) {
  if (!isAgentId(value)) return false;
  if (typeof agents?.hasAgent === 'function') {
    return agents.hasAgent(value);
  }
  return true;
}

async function resolveCommitMessageConfig(settings, agents) {
  const ui = await settings?.getUiSettings?.() ?? {};
  const generationContext = await resolveGenerationContext(agents);
  return resolveEffectiveGenerationUiConfig({
    persisted: ui?.commitMessage,
    ...generationContext,
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isValidLineIndices(value) {
  return Array.isArray(value) && value.every(isNonNegativeInteger);
}

function boundaryCheckedOptions(options) {
  if (!options || typeof options !== 'object') return options;
  const next = { ...options };
  if (typeof next.projectPath === 'string') {
    next.projectPath = assertWithinProjectBase(next.projectPath);
  }
  if (typeof next.worktreePath === 'string') {
    next.worktreePath = assertWithinProjectBase(next.worktreePath);
  }
  return next;
}

function createBoundaryCheckedGitService(git) {
  return new Proxy(git, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'toHttpError' && typeof value === 'function') {
        return (error) => isProjectBoundaryError(error)
          ? projectBoundaryErrorResponse()
          : value.call(target, error);
      }
      if (typeof value !== 'function') return value;
      return (options, ...args) => value.call(target, boundaryCheckedOptions(options), ...args);
    },
  });
}

export default function createGitRoutes(agents, settings) {
  const git = createBoundaryCheckedGitService(createGitService({ agents, classifyGitError }));

  async function getStatus(request, url) {
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

  async function getDiff(request, url) {
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

  async function getFileWithDiff(request, url) {
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

  async function postInitialCommit(body) {
    try {
      const project = body.project;
      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }

      const result = await git.initialCommit({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postCommit(body) {
    try {
      const { project, message, files } = body;
      if (!project || !message || !files || files.length === 0) {
        return Response.json({ error: 'Missing required parameters: project, message, and files.' }, { status: 400 });
      }

      const result = await git.commit({ projectPath: project, message, files });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getBranches(request, url) {
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

  async function postCheckout(body) {
    try {
      const { project, branch } = body;
      if (!project || !branch) {
        return Response.json({ error: 'Missing required parameters: project and branch.' }, { status: 400 });
      }

      const result = await git.checkout({ projectPath: project, branch });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postCreateBranch(body) {
    try {
      const { project, branch } = body;
      if (!project || !branch) {
        return Response.json({ error: 'Missing required parameters: project and branchName.' }, { status: 400 });
      }

      const result = await git.createBranch({ projectPath: project, branch });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getCommits(request, url) {
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

  async function getCommitDiff(request, url) {
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

  async function postGenerateCommitMessage(body) {
    try {
      const { project, files } = body;
      if (!project || !files || files.length === 0) {
        return Response.json({ error: 'Missing required parameters: project and files.' }, { status: 400 });
      }
      if (hasOwn(body, 'agentId') && !isAllowedGenerationAgent(agents, body.agentId)) {
        return Response.json({ error: 'Invalid agent.' }, { status: 400 });
      }

      const persistedConfig = await resolveCommitMessageConfig(settings, agents);
      const agentId = hasOwn(body, 'agentId') ? body.agentId : persistedConfig.agentId;
      const model = hasOwn(body, 'model')
        ? (typeof body.model === 'string' ? body.model : '')
        : (typeof persistedConfig.model === 'string' ? persistedConfig.model : '');
      const apiProviderId = hasOwn(body, 'apiProviderId')
        ? optionalId(body.apiProviderId)
        : (persistedConfig.apiProviderId ?? null);
      const modelEndpointId = hasOwn(body, 'modelEndpointId')
        ? optionalId(body.modelEndpointId)
        : (persistedConfig.modelEndpointId ?? null);
      const modelProtocol = hasOwn(body, 'modelProtocol')
        ? optionalProtocol(body.modelProtocol)
        : (persistedConfig.modelProtocol ?? null);
      const customPrompt = hasOwn(body, 'customPrompt')
        ? (typeof body.customPrompt === 'string' ? body.customPrompt : '')
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

  async function getRemoteStatus(request, url) {
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

  async function postFetch(body) {
    try {
      const project = body.project;
      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }

      const result = await git.fetch({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postPull(body) {
    try {
      const project = body.project;
      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }

      const result = await git.pull({ projectPath: project });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postPush(body) {
    try {
      const { project, remote, remoteBranch } = body;
      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }

      const result = await git.push({ projectPath: project, remote, remoteBranch });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getRemotes(request, url) {
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

  async function postDiscard(body) {
    try {
      const { project, file } = body;
      if (!project || !file) {
        return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
      }

      const result = await git.discard({ projectPath: project, file });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postDeleteUntracked(body) {
    try {
      const { project, file } = body;
      if (!project || !file) {
        return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
      }

      const result = await git.deleteUntracked({ projectPath: project, file });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getFileReviewData(request, url) {
    const project = url.searchParams.get('project');
    const file = url.searchParams.get('file');
    const mode = url.searchParams.get('mode') || 'working';
    const context = Number(url.searchParams.get('context') || 5);

    if (!project || !file) {
      return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
    }
    if (mode !== 'working' && mode !== 'staged') {
      return Response.json({ error: 'Invalid mode. Expected one of: working, staged.' }, { status: 400 });
    }

    try {
      const result = await git.getFileReviewData({ projectPath: project, file, mode, context });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function getChangesTree(request, url) {
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

  async function postFileReviewDataBatch(body) {
    try {
      const { project, files, mode, context } = body;

      if (!project || !Array.isArray(files) || files.length === 0) {
        return Response.json({ error: 'Missing required parameters: project and files.' }, { status: 400 });
      }
      if (!files.every(isNonEmptyString)) {
        return Response.json({ error: 'files must be a non-empty array of file paths.' }, { status: 400 });
      }
      if (mode !== 'working' && mode !== 'staged') {
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

  async function postStageSelection(body) {
    try {
      const { project, file, mode, selection, contextLines } = body;

      if (!project || !file || !mode || !selection?.lineIndices) {
        return Response.json({ error: 'Missing required parameters: project, file, mode, and selection.lineIndices.' }, { status: 400 });
      }
      if (mode !== 'stage' && mode !== 'unstage') {
        return Response.json({ error: 'Invalid mode. Expected one of: stage, unstage.' }, { status: 400 });
      }
      if (!isValidLineIndices(selection.lineIndices)) {
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

  async function postStageHunk(body) {
    try {
      const { project, file, mode, hunkIndex, contextLines } = body;

      if (!project || !file || !mode || hunkIndex === undefined) {
        return Response.json({ error: 'Missing required parameters: project, file, mode, and hunkIndex.' }, { status: 400 });
      }
      if (mode !== 'stage' && mode !== 'unstage') {
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

  async function getRepoInfo(request, url) {
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

  async function getWorktrees(request, url) {
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

  async function getTargets(request, url) {
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

  async function postCreateWorktree(body) {
    try {
      const { project, baseRef, worktreePath, branch, detach } = body;

      if (!project || !worktreePath) {
        return Response.json({ error: 'Missing required parameters: project and worktreePath.' }, { status: 400 });
      }

      const result = await git.createWorktree({ projectPath: project, baseRef, worktreePath, branch, detach });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postRemoveWorktree(body) {
    try {
      const { project, worktreePath, force } = body;

      if (!project || !worktreePath) {
        return Response.json({ error: 'Missing required parameters: project and worktreePath.' }, { status: 400 });
      }

      const result = await git.removeWorktree({ projectPath: project, worktreePath, force });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postCommitIndex(body) {
    try {
      const { project, message } = body;

      if (!project || !message) {
        return Response.json({ error: 'Missing required parameters: project and message.' }, { status: 400 });
      }

      const result = await git.commitIndex({ projectPath: project, message });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postStageFile(body) {
    try {
      const { project, file, mode } = body;

      if (!project || !file || !mode) {
        return Response.json({ error: 'Missing required parameters: project, file, and mode.' }, { status: 400 });
      }
      if (mode !== 'stage' && mode !== 'unstage') {
        return Response.json({ error: 'Invalid mode. Expected one of: stage, unstage.' }, { status: 400 });
      }

      const result = await git.stageFile({ projectPath: project, file, mode });
      return Response.json(result);
    } catch (error) {
      return git.toHttpError(error);
    }
  }

  async function postRevertLastCommit(body) {
    try {
      const { project, strategy } = body;

      if (!project) {
        return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
      }

      const effectiveStrategy = strategy || 'revert';
      if (effectiveStrategy !== 'revert' && effectiveStrategy !== 'reset-soft') {
        return Response.json({ error: 'Invalid strategy. Expected one of: revert, reset-soft.' }, { status: 400 });
      }

      const result = await git.revertLastCommit({ projectPath: project, strategy: effectiveStrategy });
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
