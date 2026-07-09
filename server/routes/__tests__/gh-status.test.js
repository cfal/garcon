import { describe, it, expect, mock } from 'bun:test';
import createGhRoutes from '../gh.js';

function makeService(overrides = {}) {
  return {
    getStatus: mock(() =>
      Promise.resolve({
        available: true,
        authenticated: true,
        reason: 'authenticated',
        host: 'github.com',
        login: 'octocat',
      }),
    ),
    listPullRequests: mock(() => Promise.resolve({ pulls: [], repo: null })),
    getPullRequest: mock(() => Promise.resolve({})),
    toHttpError: mock((error) =>
      Response.json(
        { error: error instanceof Error ? error.message : 'failed', errorCode: 'UNKNOWN' },
        { status: 500 },
      ),
    ),
    ...overrides,
  };
}

describe('GET /api/v1/gh/status', () => {
  it('returns the service status payload without requiring project', async () => {
    const service = makeService();
    const routes = createGhRoutes(service);
    const url = new URL('http://localhost/api/v1/gh/status');

    const response = await routes['/api/v1/gh/status'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      available: true,
      authenticated: true,
      reason: 'authenticated',
      host: 'github.com',
      login: 'octocat',
    });
    expect(service.getStatus).toHaveBeenCalledTimes(1);
  });

  it('maps unexpected service failures through toHttpError', async () => {
    const failure = new Error('unexpected');
    const service = makeService({
      getStatus: mock(() => Promise.reject(failure)),
    });
    const routes = createGhRoutes(service);
    const url = new URL('http://localhost/api/v1/gh/status');

    const response = await routes['/api/v1/gh/status'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('unexpected');
    expect(service.toHttpError).toHaveBeenCalledWith(failure);
  });
});
