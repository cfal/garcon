import { beforeEach, describe, expect, it, mock } from 'bun:test';

const launchProviderAuthLogin = mock(() => ({ launched: true, alreadyRunning: false }));

mock.module('../../providers/auth-login.js', () => ({
  launchProviderAuthLogin,
}));

import createProviderRoutes from '../providers.js';

describe('provider auth login routes', () => {
  const providers = {
    getAuthStatus: mock(() => Promise.resolve(null)),
    getAuthStatusMap: mock(() => Promise.resolve({})),
  };
  const routes = createProviderRoutes(providers);

  beforeEach(() => {
    launchProviderAuthLogin.mockClear();
  });

  it('launches Claude login via the provider auth route', async () => {
    const handler = routes['/api/v1/claude/auth/login'].POST;

    const response = await handler(new Request('http://localhost/api/v1/claude/auth/login', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ launched: true, alreadyRunning: false });
    expect(launchProviderAuthLogin).toHaveBeenCalledWith('claude');
  });

  it('returns an error response when auth launch fails', async () => {
    const handler = routes['/api/v1/codex/auth/login'].POST;
    launchProviderAuthLogin.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    const response = await handler(new Request('http://localhost/api/v1/codex/auth/login', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('spawn failed');
  });
});
