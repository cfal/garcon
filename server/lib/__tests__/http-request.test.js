import { beforeEach, describe, expect, it, mock } from 'bun:test';

const verifyAuthToken = mock(async () => true);

mock.module('../../auth/token.js', () => ({
  verifyAuthToken,
}));

import { authenticateHttpRequest } from '../http-request.js';

describe('authenticateHttpRequest', () => {
  beforeEach(() => {
    verifyAuthToken.mockReset();
    verifyAuthToken.mockResolvedValue(true);
  });

  it('returns 401 when bearer token is missing', async () => {
    const result = await authenticateHttpRequest(new Request('http://localhost/api/private'));
    const body = await result.errorResponse.json();

    expect(result.errorResponse.status).toBe(401);
    expect(body.error).toBe('Access denied. No token provided.');
  });

  it('returns 401 when bearer token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(false);

    const result = await authenticateHttpRequest(new Request('http://localhost/api/private', {
      headers: { authorization: 'Bearer bad-token' },
    }));
    const body = await result.errorResponse.json();

    expect(result.errorResponse.status).toBe(401);
    expect(body.error).toBe('Invalid token');
  });
});
