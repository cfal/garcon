import { expect, test } from 'bun:test';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

function sendChunkedLogin(baseUrl: string, chunks: Uint8Array[]): Promise<{
  status: number | undefined; headers: IncomingHttpHeaders; body: unknown;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

test('public authentication rejects oversized and malformed chunked bodies without disabling healthy requests', async () => {
  await withIntegrationFixture('auth-request-bounds', async ({ garcon, client }) => {
    const encoder = new TextEncoder();
    const cases = [
      { chunks: [encoder.encode('{"padding":"'), encoder.encode('x'.repeat(4096)), encoder.encode('"}')],
        status: 413, errorCode: 'AUTH_REQUEST_TOO_LARGE' },
      { chunks: [encoder.encode('{"username":"'), Uint8Array.of(0xff), encoder.encode('","password":"synthetic-password"}')],
        status: 400, errorCode: 'AUTH_VALIDATION_FAILED' },
      { chunks: [encoder.encode('{"username":"'), Uint8Array.of(0xc3)],
        status: 400, errorCode: 'AUTH_VALIDATION_FAILED' },
    ];
    for (const scenario of cases) {
      const response = await sendChunkedLogin(garcon.baseUrl, scenario.chunks);
      expect(response.status).toBe(scenario.status);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toMatchObject({ success: false, errorCode: scenario.errorCode, retryable: false });
      expect(await client.get('/api/v1/auth/status')).toMatchObject({ needsSetup: false, authDisabled: false });
      expect(await client.get('/api/v1/auth/user')).toMatchObject({ user: { username: 'integration' } });
      const healthyLogin = await sendChunkedLogin(garcon.baseUrl, [encoder.encode(JSON.stringify(garcon.credentials))]);
      expect(healthyLogin.status).toBe(200);
      expect(healthyLogin.body).toMatchObject({ success: true, user: { username: 'integration' }, token: expect.any(String) });
    }
    expect((await fetch(`${garcon.baseUrl}/api/v1/chats`)).status).toBe(401);
  });
}, 30_000);
