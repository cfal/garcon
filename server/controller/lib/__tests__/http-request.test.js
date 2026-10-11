import { beforeEach, describe, expect, it, mock } from 'bun:test';

const claims = { ownerKey: 'original', credentialRevision: 2, username: 'ada', expiresAtMs: 2_000_000_000_000 };
const verifyAuthTokenClaims = mock(async () => claims);

mock.module('../../auth/token.js', () => ({
  verifyAuthTokenClaims,
}));

import { authenticateHttpRequest } from '../http-request.js';

describe('authenticateHttpRequest', () => {
  beforeEach(() => {
    verifyAuthTokenClaims.mockReset();
    verifyAuthTokenClaims.mockResolvedValue(claims);
  });

  it('returns 401 when bearer token is missing', async () => {
    verifyAuthTokenClaims.mockResolvedValue(null);
    const result = await authenticateHttpRequest(new Request('http://localhost/api/private'));
    const body = await result.errorResponse.json();

    expect(result.errorResponse.status).toBe(401);
    expect(body.errorCode).toBe('AUTH_SESSION_INVALID');
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
      key: 'original',
      credentialRevision: 2,
      username: 'ada',
      expiresAtMs: 2_000_000_000_000,
    });
    expect(verifyAuthTokenClaims).toHaveBeenCalledWith('valid-token');
  });

  it('accepts the process-scoped local capability before JWT verification', async () => {
    const capability = `garcon_local_${'a'.repeat(43)}`;
    const result = await authenticateHttpRequest(new Request('http://localhost/api/private', {
      headers: { authorization: `Bearer ${capability}` },
    }), { localCapability: capability });

    expect(result.errorResponse).toBeNull();
    expect(result.principal).toEqual({
      mode: 'local',
      key: 'local',
      username: 'local',
      expiresAtMs: null,
    });
    expect(verifyAuthTokenClaims).not.toHaveBeenCalled();
  });

  it('rejects a Unicode token with equal character length without throwing', async () => {
    verifyAuthTokenClaims.mockResolvedValue(null);
    const capability = `garcon_local_${'a'.repeat(43)}`;
    const token = `garcon_local_\u00e9${'a'.repeat(42)}`;
    expect(token.length).toBe(capability.length);

    const result = await authenticateHttpRequest(new Request('http://localhost/api/private', {
      headers: { authorization: `Bearer ${token}` },
    }), { localCapability: capability });

    expect(result.errorResponse.status).toBe(401);
    expect(result.principal).toBeNull();
  });
});
