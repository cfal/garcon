import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import authRoutes from '../auth.js';
import { resetServerConfigForTests } from '../../config.js';
import { getAuthService } from '../../auth/service.js';
import { getAuthStore } from '../../auth/store.js';
import { authenticateHttpRequest } from '../../lib/http-request.js';

function registerRequest(body = {}) {
  return new Request('http://localhost/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function serverForAddress(address) {
  return {
    requestIP: mock(() => ({ address, family: 'IPv4', port: 1234 })),
  };
}

describe('POST /api/v1/auth/register', () => {
  let configDir;
  let originalConfigDir;
  let originalAuthDisabled;

  beforeEach(async () => {
    originalConfigDir = process.env.GARCON_CONFIG_DIR;
    originalAuthDisabled = process.env.GARCON_AUTH_DISABLED;
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-auth-route-'));
    process.env.GARCON_CONFIG_DIR = configDir;
    process.env.GARCON_AUTH_DISABLED = 'false';
    resetServerConfigForTests();
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.GARCON_CONFIG_DIR;
    else process.env.GARCON_CONFIG_DIR = originalConfigDir;
    if (originalAuthDisabled === undefined) delete process.env.GARCON_AUTH_DISABLED;
    else process.env.GARCON_AUTH_DISABLED = originalAuthDisabled;
    resetServerConfigForTests();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('rate limits registration attempts before expensive setup work', async () => {
    const handler = authRoutes['/api/v1/auth/register'].POST;
    const url = new URL('http://localhost/api/v1/auth/register');
    const server = serverForAddress('203.0.113.44');

    for (let i = 0; i < 10; i += 1) {
      const response = await handler(registerRequest(), url, server);
      expect(response.status).toBe(400);
    }

    const limited = await handler(registerRequest(), url, server);
    const body = await limited.json();

    expect(limited.status).toBe(429);
    expect(body.errorCode).toBe('RATE_LIMITED');
  });

  it('returns one token and one conflict for concurrent initial registrations', async () => {
    const handler = authRoutes['/api/v1/auth/register'].POST;
    const url = new URL('http://localhost/api/v1/auth/register');
    const server = serverForAddress('203.0.113.45');

    const responses = await Promise.all([
      handler(registerRequest({ username: 'alice', password: 'password-a' }), url, server),
      handler(registerRequest({ username: 'bob', password: 'password-b' }), url, server),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const successIndex = responses.findIndex((response) => response.status === 200);
    const conflictIndex = responses.findIndex((response) => response.status === 409);

    expect(successIndex).not.toBe(-1);
    expect(conflictIndex).not.toBe(-1);
    expect(typeof bodies[successIndex].token).toBe('string');
    expect(bodies[conflictIndex]).toEqual({
      success: false, error: 'Account already configured', errorCode: 'VALIDATION_FAILED', retryable: false,
    });
  });

  it('changes username and password independently, rejects old JWTs, and keeps the replacement signed in', async () => {
    let session = await getAuthService().register({ username: 'owner-before', password: 'password-before' });
    const initialToken = session.token;
    for (const [operation, body] of [
      ['username', { currentPassword: 'password-before', username: 'owner-after' }],
      ['password', { currentPassword: 'password-before', newPassword: 'password-after' }],
    ]) {
      const request = new Request(`http://localhost/api/v1/auth/${operation}`, { method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify(body) });
      const auth = await authenticateHttpRequest(request);
      expect(auth.errorResponse).toBeNull();
      const response = await authRoutes[new URL(request.url).pathname].PATCH(request, new URL(request.url), serverForAddress('credentials-test'), { principal: auth.principal });
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      session = await response.json();
      expect(session.user).toEqual({ id: 'owner-before', username: 'owner-after' });
    }
    const old = await authenticateHttpRequest(new Request('http://localhost/api/v1/auth/user', { headers: { Authorization: `Bearer ${initialToken}` } }));
    expect(await old.errorResponse.json()).toMatchObject({ errorCode: 'AUTH_SESSION_INVALID' });
    const valid = await authenticateHttpRequest(new Request('http://localhost/api/v1/auth/user', { headers: { Authorization: `Bearer ${session.token}` } }));
    expect(valid.principal).toMatchObject({ key: 'owner-before', username: 'owner-after', credentialRevision: 3 });
  });

  it('rejects non-browser principals, wrong passwords and combined bodies without rotating', async () => {
    await getAuthService().register({ username: 'owner', password: 'password-before' });
    const principal = { mode: 'authenticated', key: 'owner', username: 'owner', credentialRevision: 1, expiresAtMs: Date.now() + 60000 };
    for (const [caller, body, expected] of [
      [{ mode: 'local' }, { currentPassword: 'password-before', username: 'next' }, 'AUTH_CHANGE_FORBIDDEN'],
      [{ mode: 'executor' }, { currentPassword: 'password-before', username: 'next' }, 'AUTH_CHANGE_FORBIDDEN'],
      [principal, { currentPassword: 'wrong', username: 'next' }, 'AUTH_CURRENT_PASSWORD_INVALID'],
      [principal, { currentPassword: 'password-before', username: 'next', newPassword: 'not-accepted' }, 'AUTH_VALIDATION_FAILED'],
    ]) {
      const url = new URL('http://localhost/api/v1/auth/username');
      const response = await authRoutes[url.pathname].PATCH(new Request(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), url,
        serverForAddress('credentials-denial'), { principal: caller });
      expect((await response.json()).errorCode).toBe(expected);
    }
    expect((await getAuthStore().snapshot()).account.credentialRevision).toBe(1);
  });

  it('bounds chunked JSON before authentication work', async () => {
    const url = new URL('http://localhost/api/v1/auth/login');
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4097)); controller.close(); } });
    const response = await authRoutes[url.pathname].POST(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), url, serverForAddress('oversized-auth'));
    expect(response.status).toBe(413);
    expect((await response.json()).errorCode).toBe('AUTH_REQUEST_TOO_LARGE');
  });

  it.each(['status', 'register', 'login'])('returns an opaque coded failure for %s storage errors', async (operation) => {
    await fs.mkdir(path.join(configDir, 'auth.json'));
    const url = new URL(`http://localhost/api/v1/auth/${operation}`);
    const method = operation === 'status' ? 'GET' : 'POST';
    const response = await authRoutes[url.pathname][method](new Request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ username: 'synthetic', password: 'password-test' }) : undefined,
    }), url, serverForAddress(`auth-failure-${operation}`));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false, error: 'Internal server error', errorCode: 'INTERNAL_ERROR', retryable: true,
    });
  });
});
