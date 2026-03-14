import { describe, it, expect, beforeEach, mock } from 'bun:test';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
  MalformedJsonError,
}));

import createGitRoutes from '../git.js';
import { parseJsonBody } from '../../lib/http-request.js';

const ctx = {
  providers: {
    runSingleQuery: mock(() => Promise.resolve('feat: auto commit')),
  },
  settings: {
    getUiSettings: mock(() => Promise.resolve({})),
  },
};

const routes = createGitRoutes(ctx.providers, ctx.settings);

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

describe('GET /api/v1/git/changes-tree validation', () => {
  const handler = routes['/api/v1/git/changes-tree'].GET;

  it('returns 400 when project param is missing', async () => {
    const url = makeUrl('/api/v1/git/changes-tree');
    const request = new Request(url.toString());
    const response = await handler(request, url);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing required parameter: project.');
  });
});

describe('GET /api/v1/git/file-review-data validation', () => {
  const handler = routes['/api/v1/git/file-review-data'].GET;

  it('returns 400 when project is missing', async () => {
    const url = makeUrl('/api/v1/git/file-review-data', { file: 'a.ts', mode: 'working' });
    const request = new Request(url.toString());
    const response = await handler(request, url);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('required');
  });

  it('returns 400 when file is missing', async () => {
    const url = makeUrl('/api/v1/git/file-review-data', { project: '/proj', mode: 'working' });
    const request = new Request(url.toString());
    const response = await handler(request, url);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('required');
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
      Promise.resolve({ project: '/definitely-not-a-repo', files: ['a.ts'], provider: 'claude' }),
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
    expect(body.error).toBe('Request body is not valid JSON.');
  });

  it('propagates non-JSON parse errors to toHttpError', async () => {
    parseJsonBody.mockImplementation(() => { throw new Error('Stream aborted'); });
    const response = await handler(makeRequest({}));

    // Non-malformed-JSON errors fall through to git.toHttpError which returns 500.
    expect(response.status).toBe(500);
  });
});

describe('route registration', () => {
  it('registers all workbench V2 routes', () => {
    expect(routes['/api/v1/git/commit-index']).toBeDefined();
    expect(routes['/api/v1/git/commit-index'].POST).toBeFunction();

    expect(routes['/api/v1/git/stage-file']).toBeDefined();
    expect(routes['/api/v1/git/stage-file'].POST).toBeFunction();

    expect(routes['/api/v1/git/changes-tree']).toBeDefined();
    expect(routes['/api/v1/git/changes-tree'].GET).toBeFunction();

    expect(routes['/api/v1/git/file-review-data']).toBeDefined();
    expect(routes['/api/v1/git/file-review-data'].GET).toBeFunction();

    expect(routes['/api/v1/git/stage-selection']).toBeDefined();
    expect(routes['/api/v1/git/stage-selection'].POST).toBeFunction();

    expect(routes['/api/v1/git/stage-hunk']).toBeDefined();
    expect(routes['/api/v1/git/stage-hunk'].POST).toBeFunction();

    expect(routes['/api/v1/git/revert-last-commit']).toBeDefined();
    expect(routes['/api/v1/git/revert-last-commit'].POST).toBeFunction();

    expect(routes['/api/v1/git/worktrees']).toBeDefined();
    expect(routes['/api/v1/git/worktrees'].GET).toBeFunction();

    expect(routes['/api/v1/git/worktrees/create']).toBeDefined();
    expect(routes['/api/v1/git/worktrees/create'].POST).toBeFunction();

    expect(routes['/api/v1/git/worktrees/remove']).toBeDefined();
    expect(routes['/api/v1/git/worktrees/remove'].POST).toBeFunction();
  });
});
