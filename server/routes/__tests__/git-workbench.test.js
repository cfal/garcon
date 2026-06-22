import { describe, it, expect, beforeEach, mock } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'path';
import os from 'os';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

const projectBasePath = os.homedir();
const gitFixturePath = path.join(projectBasePath, 'garcon-git-route-project');

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
  MalformedJsonError,
}));

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => projectBasePath),
}));

import createGitRoutes from '../git.js';
import { parseJsonBody } from '../../lib/http-request.js';
import { GIT_DIFF_LIMITS, GIT_REVIEW_DOCUMENT_LIMITS } from '../../git/types.js';

const ctx = {
  agents: {
    runSingleQuery: mock(() => Promise.resolve('feat: auto commit')),
    getAgentAuthStatusMap: mock(() => Promise.resolve({})),
    getAgentReadinessMap: mock(() => Promise.resolve({})),
    getAgentCatalogEntries: mock(() => Promise.resolve([])),
  },
  settings: {
    getUiSettings: mock(() => ({})),
  },
};

const routes = createGitRoutes(ctx.agents, ctx.settings);

const originalDebug = console.debug;
const originalLogLevel = process.env.GARCON_LOG_LEVEL;

async function streamText(stream) {
  return stream ? new Response(stream).text() : '';
}

async function runGitCommand(cwd, args) {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    streamText(proc.stdout),
    streamText(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`);
  }
}

function restoreConsoleDebug() {
  console.debug = originalDebug;
  if (originalLogLevel === undefined) {
    delete process.env.GARCON_LOG_LEVEL;
  } else {
    process.env.GARCON_LOG_LEVEL = originalLogLevel;
  }
}

function makeUrl(path, params = {}) {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url;
}

function makeRequest(body) {
  return new Request('http://localhost/api/v1/git/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Input validation tests. These exercise the early-return validation paths
// that don't require a live git repository. Git execution behavior is
// covered by the frontend contract tests in web/src/lib/api/__tests__/.

describe('POST /api/v1/git/commit-index validation', () => {
  const handler = routes['/api/v1/git/commit-index'].POST;

  beforeEach(() => { parseJsonBody.mockClear(); });

  it('returns 400 when project is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ message: 'test' }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameters: project and message.');
  });

  it('returns 400 when message is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ project: '/proj' }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameters: project and message.');
  });

  it('returns 400 when both fields are empty strings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ project: '', message: '' }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameters: project and message.');
  });
});

describe('POST /api/v1/git/stage-file validation', () => {
  const handler = routes['/api/v1/git/stage-file'].POST;

  beforeEach(() => { parseJsonBody.mockClear(); });

  it('returns 400 when project is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ file: 'a.ts', mode: 'stage' }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameters: project, file, and mode.');
  });

  it('returns 400 when file is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ project: '/proj', mode: 'stage' }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameters: project, file, and mode.');
  });

  it('returns 400 when mode is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ project: '/proj', file: 'a.ts' }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameters: project, file, and mode.');
  });

  it('returns 400 for invalid mode value', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', file: 'a.ts', mode: 'invalid' }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid mode. Expected one of: stage, unstage.');
  });

  it('accepts stage as valid mode (passes validation)', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', file: 'a.ts', mode: 'stage' }),
    );
    const response = await handler(makeRequest({}));
    // Passes validation checks, fails at git level (500, not 400)
    expect(response.status).not.toBe(400);
  });

  it('accepts unstage as valid mode (passes validation)', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', file: 'a.ts', mode: 'unstage' }),
    );
    const response = await handler(makeRequest({}));
    expect(response.status).not.toBe(400);
  });
});

describe('POST /api/v1/git/workbench/snapshot validation', () => {
  const handler = routes['/api/v1/git/workbench/snapshot'].POST;

  beforeEach(() => {
    parseJsonBody.mockClear();
    restoreConsoleDebug();
  });

  it('returns 400 when project is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ mode: 'working', context: 5 }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameter: project.');
  });

  it('returns 400 when mode is invalid', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: gitFixturePath, mode: 'invalid', context: 5 }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid mode. Expected one of: working, staged.');
  });

  it('returns 400 when context is invalid', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: gitFixturePath, mode: 'working', context: GIT_DIFF_LIMITS.maxContextLines + 1 }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe(`Invalid context. Expected an integer between 0 and ${GIT_DIFF_LIMITS.maxContextLines}.`);
  });

  it('returns 400 when bodyCandidateCount is invalid', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: gitFixturePath, mode: 'working', context: 5, bodyCandidateCount: -1 }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid bodyCandidateCount.');
  });

  it('returns 403 when project is outside the configured base', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ project: '/', mode: 'working', context: 5 }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.errorCode).toBe('outside_project_base');
  });

  it('emits a safe route trace for successful workbench snapshot loads', async () => {
    const projectPath = await fs.mkdtemp(path.join(projectBasePath, 'garcon-git-route-trace-'));
    process.env.GARCON_LOG_LEVEL = 'debug';
    console.debug = mock(() => undefined);

    try {
      await runGitCommand(projectPath, ['init']);
      parseJsonBody.mockImplementation(() =>
        Promise.resolve({ project: projectPath, mode: 'working', context: 5, bodyCandidateCount: 8 }),
      );
      const response = await handler(makeRequest({}));
      const responseText = await response.text();
      const body = JSON.parse(responseText);
      const responseBytes = Buffer.byteLength(responseText);
      const traceLog = console.debug.mock.calls.find(
        (call) => call[0] === '[routes:git]' && call[1] === 'git workbench route',
      )?.[2];

      expect(response.status).toBe(200);
      expect(body.status).toBe('ready');
      expect(body.tree.statsState).toBe('loaded');
      expect(responseBytes).toBeLessThan(128 * 1024);
      expect(traceLog).toMatchObject({
        route: 'workbench-snapshot',
        responseBytes,
        slowestCommand: expect.objectContaining({
          args: expect.any(Array),
          durationMs: expect.any(Number),
        }),
      });
      expect(traceLog.commandCount).toBeGreaterThanOrEqual(4);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
      restoreConsoleDebug();
    }
  });
});

describe('POST /api/v1/git/worktrees/create boundary validation', () => {
  const handler = routes['/api/v1/git/worktrees/create'].POST;

  beforeEach(() => { parseJsonBody.mockClear(); });

  it('returns 403 when worktreePath is outside the configured base', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({
        project: gitFixturePath,
        worktreePath: '/',
      }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.errorCode).toBe('outside_project_base');
  });
});

describe('POST /api/v1/git/review-document validation', () => {
  const filesHandler = routes['/api/v1/git/review-document/files'].POST;

  beforeEach(() => { parseJsonBody.mockClear(); });

  it('returns 400 when body files exceed the batch limit', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({
        project: '/proj',
        documentId: 'doc',
        files: Array.from({ length: GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles + 1 }, (_, index) => `file-${index}.ts`),
        mode: 'working',
        context: 5,
      }),
    );
    const response = await filesHandler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe(`Too many files. Maximum is ${GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles}.`);
  });

 	  it('returns 400 when context is invalid', async () => {
	    parseJsonBody.mockImplementation(() =>
	      Promise.resolve({
	        project: '/proj',
	        documentId: 'doc',
	        files: ['a.ts'],
	        mode: 'working',
	        context: GIT_DIFF_LIMITS.maxContextLines + 1,
	      }),
	    );
	    const response = await filesHandler(makeRequest({}));
	    const body = await response.json();

	    expect(response.status).toBe(400);
	    expect(body.error).toBe(`Invalid context. Expected an integer between 0 and ${GIT_DIFF_LIMITS.maxContextLines}.`);
	  });
});

describe('POST /api/v1/git/stage-selection validation', () => {
  const handler = routes['/api/v1/git/stage-selection'].POST;

  beforeEach(() => { parseJsonBody.mockClear(); });

  it('returns 400 when required fields are missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ project: '/proj' }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid mode', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', file: 'a.ts', mode: 'invalid', selection: { lineIndices: [0] } }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid mode. Expected one of: stage, unstage.');
  });

  it('returns 400 for invalid lineIndices', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', file: 'a.ts', mode: 'stage', selection: { lineIndices: [0, -1] } }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('selection.lineIndices must be an array of non-negative integers.');
  });
});

describe('POST /api/v1/git/stage-hunk validation', () => {
  const handler = routes['/api/v1/git/stage-hunk'].POST;

  beforeEach(() => { parseJsonBody.mockClear(); });

  it('returns 400 when required fields are missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ project: '/proj' }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid mode', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', file: 'a.ts', mode: 'invalid', hunkIndex: 0 }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid mode. Expected one of: stage, unstage.');
  });

  it('returns 400 for invalid hunkIndex', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', file: 'a.ts', mode: 'stage', hunkIndex: -1 }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('hunkIndex must be a non-negative integer.');
  });
});

describe('POST /api/v1/git/revert-last-commit validation', () => {
  const handler = routes['/api/v1/git/revert-last-commit'].POST;

  beforeEach(() => { parseJsonBody.mockClear(); });

  it('returns 400 when project is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({}));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('required');
  });
});

describe('POST /api/v1/git/generate-commit-message contract', () => {
  const handler = routes['/api/v1/git/generate-commit-message'].POST;

  beforeEach(() => { parseJsonBody.mockClear(); });

  it('returns typed errorCode when no staged changes are found', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: path.join(projectBasePath, 'definitely-not-a-repo'), files: ['a.ts'], agentId: 'claude' }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.errorCode).toBe('commit_message_no_staged_files');
  });
});

describe('malformed JSON body', () => {
  const handler = routes['/api/v1/git/commit-index'].POST;

  beforeEach(() => { parseJsonBody.mockClear(); });

  it('returns 400 with typed error when body is not valid JSON', async () => {
    parseJsonBody.mockImplementation(() => { throw new MalformedJsonError(); });
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Malformed JSON');
  });

  it('propagates non-JSON parse errors to the caller', async () => {
    parseJsonBody.mockImplementation(() => { throw new Error('Stream aborted'); });

    await expect(handler(makeRequest({}))).rejects.toThrow('Stream aborted');
  });
});

	describe('route registration', () => {
	  it('registers workbench routes', () => {
	    const expectedRoutes = {
	      '/api/v1/git/commit-index': 'POST',
	      '/api/v1/git/stage-file': 'POST',
	      '/api/v1/git/workbench/snapshot': 'POST',
	      '/api/v1/git/review-document/files': 'POST',
	      '/api/v1/git/stage-selection': 'POST',
	      '/api/v1/git/stage-hunk': 'POST',
	      '/api/v1/git/revert-last-commit': 'POST',
	      '/api/v1/git/worktrees': 'GET',
	      '/api/v1/git/targets': 'GET',
	      '/api/v1/git/worktrees/create': 'POST',
	      '/api/v1/git/worktrees/remove': 'POST',
	      '/api/v1/git/conflicts': 'GET',
	      '/api/v1/git/conflict-details': 'GET',
	      '/api/v1/git/conflict/accept': 'POST',
	      '/api/v1/git/conflict/resolve': 'POST',
	      '/api/v1/git/stashes': 'GET',
	      '/api/v1/git/stash/create': 'POST',
	      '/api/v1/git/stash/apply': 'POST',
	      '/api/v1/git/stash/pop': 'POST',
	      '/api/v1/git/stash/drop': 'POST',
	      '/api/v1/git/file-history': 'GET',
	      '/api/v1/git/blame': 'GET',
	      '/api/v1/git/graph': 'GET',
	      '/api/v1/git/compare': 'GET',
	    };

	    for (const [route, method] of Object.entries(expectedRoutes)) {
	      expect(routes[route]).toBeDefined();
	      expect(routes[route][method]).toBeFunction();
	    }
	  });
	});
