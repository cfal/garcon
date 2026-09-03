import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import authRoutes from '../auth.js';
import { resetServerConfigForTests } from '../../config.js';

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
    expect(bodies[conflictIndex]).toEqual({ error: 'Account already configured' });
  });
});
