import { createGitService } from '../git/git-service.js';
import { classifyGitError } from '../git/git-error-classifier.js';
import { parseJsonBody, MalformedJsonError } from '../lib/http-request.js';
import { CLAUDE_MODELS, CODEX_MODELS, AMP_MODELS } from '../../common/models.js';
import { resolveEffectiveGenerationUiConfig } from '../settings/generation-effective.js';

const MALFORMED_BODY = () =>
  Response.json({ error: 'Request body is not valid JSON.' }, { status: 400 });

// Wraps parseJsonBody, returning null on malformed JSON so callers
// can return a typed 400 instead of letting the error escape.
async function readJsonBody(request) {
  try {
    return await parseJsonBody(request);
  } catch (err) {
    if (err instanceof MalformedJsonError) return null;
    throw err;
  }
}

// Thin HTTP adapter for git operations. Each handler extracts request
// parameters, delegates to the git service, and maps errors to HTTP
// responses via git.toHttpError(). No business logic lives here.
function isAllowedGenerationProvider(value) {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'amp';
}

function hasOwn(source, key) {
  return Boolean(source) && Object.prototype.hasOwnProperty.call(source, key);
}

async function resolveCommitMessageConfig(settings, providers) {
  const ui = await settings?.getUiSettings?.() ?? {};
  const authByProvider = await providers?.getAuthStatusMap?.() ?? {
    claude: { authenticated: false },
    codex: { authenticated: false },
    opencode: { authenticated: false },
    amp: { authenticated: false },
  };
  const opencodeModels = await providers?.getModels?.('opencode') ?? [];
  return resolveEffectiveGenerationUiConfig({
    persisted: ui?.commitMessage,
    authByProvider,
    modelsByProvider: {
      claude: CLAUDE_MODELS.OPTIONS,
      codex: CODEX_MODELS.OPTIONS,
      opencode: Array.isArray(opencodeModels) ? opencodeModels : [],
      amp: AMP_MODELS.OPTIONS,
    },
  });
}

export default function createGitRoutes(providers, settings) {
  const git = createGitService({ providers, classifyGitError });

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

  async function postInitialCommit(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postCommit(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postCheckout(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postCreateBranch(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postGenerateCommitMessage(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
      const { project, files } = body;
      if (!project || !files || files.length === 0) {
        return Response.json({ error: 'Missing required parameters: project and files.' }, { status: 400 });
      }
      if (hasOwn(body, 'provider') && !isAllowedGenerationProvider(body.provider)) {
        return Response.json({ error: 'Invalid provider. Expected one of: claude, codex, opencode, amp.' }, { status: 400 });
      }

      const persistedConfig = await resolveCommitMessageConfig(settings, providers);
      const provider = hasOwn(body, 'provider') ? body.provider : persistedConfig.provider;
      const model = hasOwn(body, 'model')
        ? (typeof body.model === 'string' ? body.model : '')
        : (typeof persistedConfig.model === 'string' ? persistedConfig.model : '');
      const customPrompt = hasOwn(body, 'customPrompt')
        ? (typeof body.customPrompt === 'string' ? body.customPrompt : '')
        : (typeof persistedConfig.customPrompt === 'string' ? persistedConfig.customPrompt : '');

      const result = await git.generateCommitMessageForFiles({ projectPath: project, files, provider, model, customPrompt });
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

  async function postFetch(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postPull(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postPush(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postDiscard(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postDeleteUntracked(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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
    const mode = url.searchParams.get('mode') || 'head';
    const context = Number(url.searchParams.get('context') || 5);

    if (!project || !file) {
      return Response.json({ error: 'Missing required parameters: project and file.' }, { status: 400 });
    }
    if (mode !== 'head' && mode !== 'working' && mode !== 'staged') {
      return Response.json({ error: 'Invalid mode. Expected one of: head, working, staged.' }, { status: 400 });
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

  async function postStageSelection(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
      const { project, file, mode, selection, contextLines } = body;

      if (!project || !file || !mode || !selection?.lineIndices) {
        return Response.json({ error: 'Missing required parameters: project, file, mode, and selection.lineIndices.' }, { status: 400 });
      }
      if (mode !== 'stage' && mode !== 'unstage') {
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

  async function postStageHunk(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
      const { project, file, mode, hunkIndex, contextLines } = body;

      if (!project || !file || !mode || hunkIndex === undefined) {
        return Response.json({ error: 'Missing required parameters: project, file, mode, and hunkIndex.' }, { status: 400 });
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

  async function postCreateWorktree(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postRemoveWorktree(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postCommitIndex(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postStageFile(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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

  async function postRevertLastCommit(request, url) {
    try {
      const body = await readJsonBody(request);
      if (body === null) return MALFORMED_BODY();
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
    '/api/v1/git/initial-commit': { POST: postInitialCommit },
    '/api/v1/git/commit': { POST: postCommit },
    '/api/v1/git/branches': { GET: getBranches },
    '/api/v1/git/checkout': { POST: postCheckout },
    '/api/v1/git/create-branch': { POST: postCreateBranch },
    '/api/v1/git/commits': { GET: getCommits },
    '/api/v1/git/commit-diff': { GET: getCommitDiff },
    '/api/v1/git/generate-commit-message': { POST: postGenerateCommitMessage },
    '/api/v1/git/remote-status': { GET: getRemoteStatus },
    '/api/v1/git/fetch': { POST: postFetch },
    '/api/v1/git/pull': { POST: postPull },
    '/api/v1/git/push': { POST: postPush },
    '/api/v1/git/remotes': { GET: getRemotes },
    '/api/v1/git/discard': { POST: postDiscard },
    '/api/v1/git/delete-untracked': { POST: postDeleteUntracked },
    '/api/v1/git/file-review-data': { GET: getFileReviewData },
    '/api/v1/git/changes-tree': { GET: getChangesTree },
    '/api/v1/git/stage-selection': { POST: postStageSelection },
    '/api/v1/git/stage-hunk': { POST: postStageHunk },
    '/api/v1/git/repo-info': { GET: getRepoInfo },
    '/api/v1/git/worktrees': { GET: getWorktrees },
    '/api/v1/git/worktrees/create': { POST: postCreateWorktree },
    '/api/v1/git/worktrees/remove': { POST: postRemoveWorktree },
    '/api/v1/git/revert-last-commit': { POST: postRevertLastCommit },
    '/api/v1/git/commit-index': { POST: postCommitIndex },
    '/api/v1/git/stage-file': { POST: postStageFile },
  };
}
