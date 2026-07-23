import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
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
  isHttpCompressionEnabled: mock(() => true),
}));

mock.module('../../lib/log.js', () => ({
  createLogger: (namespace) => ({
    debug: (...args) => {
      if (process.env.GARCON_LOG_LEVEL === 'debug') console.debug(`[${namespace}]`, ...args);
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

import { parseJsonBody } from '../../lib/http-request.js';
import { GIT_DIFF_LIMITS, GIT_REF_RESULT_LIMITS, GIT_REVIEW_DOCUMENT_LIMITS } from '../../git/types.js';

const originalDebug = console.debug;
const originalLogLevel = process.env.GARCON_LOG_LEVEL;
const { default: createGitRoutes } = await import('../git.js');

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

describe('POST /api/v1/git/stage-paths validation', () => {
  const handler = routes['/api/v1/git/stage-paths'].POST;

  beforeEach(() => { parseJsonBody.mockClear(); });

  it('returns 400 when project is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ paths: ['a.ts'], mode: 'stage' }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameters: project, paths, and mode.');
  });

  it('returns 400 when paths are missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ project: '/proj', mode: 'stage' }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameters: project, paths, and mode.');
  });

  it('returns 400 when paths are empty', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', paths: [], mode: 'stage' }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid paths. Expected a non-empty array of non-empty strings.');
  });

  it('returns 400 when paths contain invalid entries', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', paths: ['a.ts', ''], mode: 'stage' }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid paths. Expected a non-empty array of non-empty strings.');
  });

  it('returns 400 when paths contain NUL bytes', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', paths: ['bad\0path'], mode: 'stage' }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid paths. Pathspecs cannot contain NUL bytes.');
  });

  it('returns 400 when mode is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ project: '/proj', paths: ['a.ts'] }));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameters: project, paths, and mode.');
  });

  it('returns 400 for invalid mode value', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', paths: ['a.ts'], mode: 'invalid' }),
    );
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid mode. Expected one of: stage, unstage.');
  });

  it('accepts stage as valid mode (passes validation)', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', paths: ['a.ts'], mode: 'stage' }),
    );
    const response = await handler(makeRequest({}));
    // Passes validation checks, fails at git level (500, not 400)
    expect(response.status).not.toBe(400);
  });

  it('accepts unstage as valid mode (passes validation)', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({ project: '/proj', paths: ['a.ts'], mode: 'unstage' }),
    );
    const response = await handler(makeRequest({}));
    expect(response.status).not.toBe(400);
  });
});

describe('GET /api/v1/git/refs validation', () => {
  const handler = routes['/api/v1/git/refs'].GET;

  it('returns 400 when limit is above the route maximum', async () => {
    const url = makeUrl('/api/v1/git/refs', {
      project: gitFixturePath,
      limit: String(GIT_REF_RESULT_LIMITS.max + 1),
    });
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe(`Invalid limit. Expected an integer between 1 and ${GIT_REF_RESULT_LIMITS.max}.`);
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

describe('POST /api/v1/git/working-tree/fingerprint validation', () => {
  const handler = routes['/api/v1/git/working-tree/fingerprint'].POST;

  beforeEach(() => {
    parseJsonBody.mockClear();
    restoreConsoleDebug();
  });

  it('returns 400 when project is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({}));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameter: project.');
  });

  it('returns typed non-repository responses', async () => {
    const projectPath = await fs.mkdtemp(path.join(projectBasePath, 'garcon-git-fingerprint-not-repo-'));

    try {
      parseJsonBody.mockImplementation(() => Promise.resolve({ project: projectPath }));
      const response = await handler(makeRequest({}));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: 'not-git-repository',
        project: projectPath,
        fingerprint: null,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('emits a safe route trace for successful workbench fingerprint loads', async () => {
    const projectPath = await fs.mkdtemp(path.join(projectBasePath, 'garcon-git-fingerprint-trace-'));
    process.env.GARCON_LOG_LEVEL = 'debug';
    console.debug = mock(() => undefined);

    try {
      await runGitCommand(projectPath, ['init']);
      parseJsonBody.mockImplementation(() => Promise.resolve({ project: projectPath }));
      const response = await handler(makeRequest({}));
      const responseText = await response.text();
      const body = JSON.parse(responseText);
      const responseBytes = Buffer.byteLength(responseText);
      const traceLog = console.debug.mock.calls.find(
        (call) => call[0] === '[routes:git]' && call[1] === 'git workbench route',
      )?.[2];

      expect(response.status).toBe(200);
      expect(body.status).toBe('ready');
      expect(body.fingerprint).toStartWith('v1:');
      expect(traceLog).toMatchObject({
        route: 'working-tree-fingerprint',
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

describe('POST /api/v1/git/history routes', () => {
  const commitsHandler = routes['/api/v1/git/history/commits'].POST;
  const snapshotHandler = routes['/api/v1/git/history/commit/snapshot'].POST;
  const filesHandler = routes['/api/v1/git/history/commit/files'].POST;

  beforeEach(() => {
    parseJsonBody.mockClear();
    restoreConsoleDebug();
  });

  it('validates commit list pagination', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ project: gitFixturePath, limit: 201 }));
    const response = await commitsHandler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid history pagination parameters.');
  });

  it('requires project and commit for snapshot requests', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ project: gitFixturePath, context: 5 }));
    const response = await snapshotHandler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameters: project and commit.');
  });

  it('validates commit snapshot context and candidate count', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({
        project: gitFixturePath,
        commit: 'HEAD',
        context: GIT_DIFF_LIMITS.maxContextLines + 1,
        bodyCandidateCount: 8,
      }),
    );
    const response = await snapshotHandler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid commit snapshot parameters.');
  });

  it('rejects oversized commit body batches', async () => {
    parseJsonBody.mockImplementation(() =>
      Promise.resolve({
        project: gitFixturePath,
        documentId: 'doc',
        commit: 'HEAD',
        context: 5,
        files: Array.from(
          { length: GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles + 1 },
          (_, index) => `f${index}.ts`,
        ),
      }),
    );
    const response = await filesHandler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe(`Too many files. Maximum is ${GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles}.`);
  });

  it('returns structured snapshot and file bodies for a commit', async () => {
    const projectPath = await fs.mkdtemp(path.join(projectBasePath, 'garcon-git-history-route-'));

    try {
      await runGitCommand(projectPath, ['init']);
      await runGitCommand(projectPath, ['config', 'user.email', 'test@example.com']);
      await runGitCommand(projectPath, ['config', 'user.name', 'Test User']);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'a.txt']);
      await runGitCommand(projectPath, ['commit', '-m', 'initial']);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\n', 'utf-8');
      await runGitCommand(projectPath, ['commit', '-am', 'change']);

      parseJsonBody.mockImplementation(() =>
        Promise.resolve({ project: projectPath, commit: 'HEAD', context: 5, bodyCandidateCount: 8 }),
      );
      const snapshotResponse = await snapshotHandler(makeRequest({}));
      const snapshot = await snapshotResponse.json();

      expect(snapshotResponse.status).toBe(200);
      expect(snapshot.status).toBe('ready');
      expect(snapshot.files[0]).toMatchObject({ path: 'a.txt', bodyState: 'unloaded' });

      parseJsonBody.mockImplementation(() =>
        Promise.resolve({
          project: projectPath,
          documentId: snapshot.documentId,
          commit: snapshot.commit.hash,
          parent: snapshot.selectedParent,
          context: 5,
          files: ['a.txt'],
        }),
      );
      const filesResponse = await filesHandler(makeRequest({}));
      const body = await filesResponse.json();

      expect(filesResponse.status).toBe(200);
      expect(body.files['a.txt'].bodyFingerprint).toBe(snapshot.files[0].bodyFingerprint);
      expect(body.files['a.txt'].rows.some((row) => row.kind === 'add' && row.text === 'two')).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('POST /api/v1/git/comparison routes', () => {
  const snapshotHandler = routes['/api/v1/git/comparisons/snapshot'].POST;
  const filesHandler = routes['/api/v1/git/comparisons/files'].POST;

  beforeEach(() => {
    parseJsonBody.mockClear();
    restoreConsoleDebug();
  });

  it('requires a revision From endpoint', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: gitFixturePath,
      from: { kind: 'working-tree' },
      to: { kind: 'revision', revision: 'HEAD' },
      mode: 'direct',
    }));
    const response = await snapshotHandler(makeRequest({}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Missing or invalid comparison endpoints, project, or mode.',
    });
  });

  it('rejects merge-base mode for a Working Tree target', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: gitFixturePath,
      from: { kind: 'revision', revision: 'HEAD' },
      to: { kind: 'working-tree' },
      mode: 'merge-base',
    }));
    const response = await snapshotHandler(makeRequest({}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Working Tree comparisons require direct mode.',
    });
  });

  it('rejects oversized body batches', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: gitFixturePath,
      documentId: 'doc',
      effectiveFromHash: 'a'.repeat(40),
      to: { kind: 'revision', hash: 'b'.repeat(40) },
      files: Array.from(
        { length: GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles + 1 },
        (_, index) => ({ path: `f${index}.ts` }),
      ),
    }));
    const response = await filesHandler(makeRequest({}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: `Too many files. Maximum is ${GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles}.`,
    });
  });

  it('returns a typed snapshot and lazy body response', async () => {
    const projectPath = await fs.mkdtemp(path.join(projectBasePath, 'garcon-git-comparison-route-'));
    try {
      await runGitCommand(projectPath, ['init']);
      await runGitCommand(projectPath, ['config', 'user.email', 'test@example.com']);
      await runGitCommand(projectPath, ['config', 'user.name', 'Test User']);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\n', 'utf8');
      await runGitCommand(projectPath, ['add', 'a.txt']);
      await runGitCommand(projectPath, ['commit', '-m', 'initial']);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\n', 'utf8');
      await runGitCommand(projectPath, ['commit', '-am', 'second']);

      parseJsonBody.mockImplementation(() => Promise.resolve({
        project: projectPath,
        from: { kind: 'revision', revision: 'HEAD~1' },
        to: { kind: 'revision', revision: 'HEAD' },
        mode: 'direct',
      }));
      const snapshotResponse = await snapshotHandler(makeRequest({}));
      const snapshot = await snapshotResponse.json();
      expect(snapshotResponse.status).toBe(200);
      expect(snapshot).toMatchObject({ status: 'ready', mode: 'direct' });

      parseJsonBody.mockImplementation(() => Promise.resolve({
        project: projectPath,
        documentId: snapshot.documentId,
        effectiveFromHash: snapshot.effectiveFromHash,
        to: { kind: 'revision', hash: snapshot.to.hash },
        files: [{ path: 'a.txt' }],
      }));
      const filesResponse = await filesHandler(makeRequest({}));
      const bodies = await filesResponse.json();
      expect(filesResponse.status).toBe(200);
      expect(bodies.status).toBe('ready');
      expect(bodies.files['a.txt']).toMatchObject({
        bodyState: 'loaded',
        renderedRowCount: expect.any(Number),
        patchBytes: expect.any(Number),
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
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

describe('POST /api/v1/git/revert-commit validation', () => {
  const handler = routes['/api/v1/git/revert-commit'].POST;

  beforeEach(() => { parseJsonBody.mockClear(); });

  it('returns 400 when project or commit is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({}));
    const response = await handler(makeRequest({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameters: project and commit.');
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
  afterEach(() => {
    parseJsonBody.mockImplementation((request) => request.json());
  });

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
      '/api/v1/git/stage-paths': 'POST',
      '/api/v1/git/workbench/snapshot': 'POST',
      '/api/v1/git/working-tree/fingerprint': 'POST',
      '/api/v1/git/review-document/files': 'POST',
      '/api/v1/git/history/commits': 'POST',
      '/api/v1/git/history/commit/snapshot': 'POST',
      '/api/v1/git/history/commit/files': 'POST',
      '/api/v1/git/comparisons/snapshot': 'POST',
      '/api/v1/git/comparisons/files': 'POST',
      '/api/v1/git/stage-selection': 'POST',
      '/api/v1/git/stage-hunk': 'POST',
      '/api/v1/git/revert-commit': 'POST',
      '/api/v1/git/worktrees': 'GET',
      '/api/v1/git/refs': 'GET',
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
    };

    for (const [route, method] of Object.entries(expectedRoutes)) {
      expect(routes[route]).toBeDefined();
      expect(routes[route][method]).toBeFunction();
    }
  });
});
