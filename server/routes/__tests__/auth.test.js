import { describe, expect, it, mock } from 'bun:test';

import authRoutes from '../auth.js';

function registerRequest() {
  return new Request('http://localhost/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

function serverForAddress(address) {
  return {
    requestIP: mock(() => ({ address, family: 'IPv4', port: 1234 })),
  };
}

describe('POST /api/v1/auth/register', () => {
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
});
