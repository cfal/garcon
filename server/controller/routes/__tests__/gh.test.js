import { describe, it, expect, mock } from 'bun:test';
import createGhRoutes from '../gh.js';
import { GH_DETAIL_TIMEOUT_MS, GIT_OPERATION_TIMEOUT_MS } from '../../../../common/git-execution.js';

function makeService(overrides = {}) {
  return {
    getStatus: mock(() =>
      Promise.resolve({
        executorId: 'local',
        instanceId: 'test-instance',
        available: true,
        authenticated: true,
        reason: 'authenticated',
        host: 'github.com',
        login: 'octocat',
      }),
    ),
    listPullRequests: mock(() => Promise.resolve({ executorId: 'local', instanceId: 'test-instance', pulls: [], repo: null })),
    getPullRequest: mock(() => Promise.resolve({ executorId: 'local', instanceId: 'test-instance' })),
    ...overrides,
  };
}

describe('GET /api/v1/gh/status', () => {
  it('returns the service status payload without requiring project', async () => {
    const service = makeService();
    const routes = createGhRoutes(async () => service);
    const url = new URL('http://localhost/api/v1/gh/status');

    const response = await routes['/api/v1/gh/status'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      executorId: 'local',
      instanceId: 'test-instance',
      available: true,
      authenticated: true,
      reason: 'authenticated',
      host: 'github.com',
      login: 'octocat',
    });
    expect(service.getStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects missing or mismatched scope instead of relabeling a service response', async () => {
    for (const scope of [{}, { executorId: 'other-executor', instanceId: 'test-instance' }]) {
      const routes = createGhRoutes(async () => makeService({ getStatus: async () => scope }));
      const url = new URL('http://localhost/api/v1/gh/status');
      const response = await routes['/api/v1/gh/status'].GET(new Request(url), url);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ errorCode: 'GIT_INVALID_RESULT' });
    }
  });

  it('maps unexpected service failures without leaking untyped details', async () => {
    const failure = new Error('unexpected');
    const service = makeService({
      getStatus: mock(() => Promise.reject(failure)),
    });
    const routes = createGhRoutes(async () => service);
    const url = new URL('http://localhost/api/v1/gh/status');

    const response = await routes['/api/v1/gh/status'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Internal server error');
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});

describe('GitHub route dispatch', () => {
  const operations = [
    ['status', 'getStatus', '', undefined, GIT_OPERATION_TIMEOUT_MS],
    ['pull-requests', 'listPullRequests', 'project=%2Fproject', { projectPath: '/project' }, GIT_OPERATION_TIMEOUT_MS],
    ['pull-request', 'getPullRequest', 'project=%2Fproject&number=42', { projectPath: '/project', number: 42 }, GH_DETAIL_TIMEOUT_MS],
  ];

  it.each(operations)('dispatches %s with the selected executor, signal, and bounded timeout', async (path, method, query, input, maximum) => {
    const executorId = '11111111-1111-4111-8111-111111111111';
    const payload = { executorId, instanceId: 'test-instance' };
    const service = makeService({ [method]: mock(async () => payload) });
    const resolve = mock(async () => service);
    const routes = createGhRoutes(resolve, maximum + 1);
    const url = new URL(`http://localhost/api/v1/gh/${path}?executorId=${executorId}&${query}`);
    const request = new Request(url);
    const response = await routes[url.pathname].GET(request, url);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(resolve).toHaveBeenCalledWith(executorId);
    const options = { signal: request.signal, timeoutMs: maximum };
    expect(service[method]).toHaveBeenCalledWith(...(input ? [input, options] : [options]));
    for (const other of Object.keys(service)) {
      if (other !== method) expect(service[other]).not.toHaveBeenCalled();
    }
  });

  it.each(operations)('honors a shorter caller timeout for %s', async (path, method, query) => {
    const service = makeService();
    const routes = createGhRoutes(async () => service, 123);
    const url = new URL(`http://localhost/api/v1/gh/${path}?${query}`);
    expect((await routes[url.pathname].GET(new Request(url), url)).status).toBe(200);
    expect(service[method].mock.calls[0].at(-1).timeoutMs).toBe(123);
  });

  it.each([
    ['status', 'project=/project'],
    ['status', 'executorId=local&executorId=local'],
    ['pull-requests', ''],
    ['pull-requests', 'project=/project&number=42'],
    ['pull-request', 'project=/project&number=0'],
    ['pull-request', 'project=/project&number=1&number=2'],
  ])('rejects invalid %s fields before resolving an executor', async (path, query) => {
    const resolve = mock(async () => makeService());
    const routes = createGhRoutes(resolve);
    const url = new URL(`http://localhost/api/v1/gh/${path}?${query}`);
    const response = await routes[url.pathname].GET(new Request(url), url);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorCode: 'GIT_INVALID_INPUT' });
    expect(resolve).not.toHaveBeenCalled();
  });
});
