import { beforeEach, describe, expect, it, mock } from 'bun:test';

const verifyAuthTokenClaims = mock(async () => ({ username: 'ada', expiresAtMs: 2_000_000_000_000 }));

mock.module('../../auth/token.js', () => ({
  verifyAuthTokenClaims,
}));

import { authenticateHttpRequest } from '../http-request.js';

describe('authenticateHttpRequest', () => {
  beforeEach(() => {
    verifyAuthTokenClaims.mockReset();
    verifyAuthTokenClaims.mockResolvedValue({ username: 'ada', expiresAtMs: 2_000_000_000_000 });
  });

  it('returns 401 when bearer token is missing', async () => {
    const result = await authenticateHttpRequest(new Request('http://localhost/api/private'));
    const body = await result.errorResponse.json();

    expect(result.errorResponse.status).toBe(401);
    expect(body.error).toBe('Access denied. No token provided.');
  });

  it('returns 401 when bearer token is invalid', async () => {
    verifyAuthTokenClaims.mockResolvedValue(null);

    const result = await authenticateHttpRequest(new Request('http://localhost/api/private', {
      headers: { authorization: 'Bearer bad-token' },
    }));
    const body = await result.errorResponse.json();

    expect(result.errorResponse.status).toBe(401);
    expect(body.error).toBe('Invalid token');
  });

  it('returns a trusted principal from verified claims', async () => {
    const result = await authenticateHttpRequest(new Request('http://localhost/api/private', {
      headers: { authorization: 'Bearer valid-token' },
    }));

    expect(result.errorResponse).toBeNull();
    expect(result.principal).toEqual({
      mode: 'authenticated',
      key: 'ada',
      username: 'ada',
      expiresAtMs: 2_000_000_000_000,
    });
    expect(verifyAuthTokenClaims).toHaveBeenCalledWith('valid-token');
  });
});
