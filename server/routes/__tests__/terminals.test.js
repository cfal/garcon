import { describe, expect, it } from 'bun:test';
import createTerminalRoutes from '../terminals.ts';
import { TerminalManagerError } from '../../terminals/terminal-manager.ts';

const principal = {
  mode: 'authenticated',
  key: 'alice',
  username: 'alice',
  expiresAtMs: Date.now() + 60_000,
};

const metadata = {
  terminalId: 'terminal-1',
  displaySequence: 1,
  initialWorkingDirectory: '/workspace',
  processStatus: 'running',
  attachmentStatus: 'detached',
  createdAt: '2026-07-13T00:00:00.000Z',
  exitCode: null,
  latestOutputSequence: 0,
};

function request(url, method = 'GET', body) {
  return new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

describe('terminal routes', () => {
  it('requires a trusted request principal', async () => {
    const routes = createTerminalRoutes({ list: () => [] });
    const url = new URL('http://localhost/api/v1/terminals');
    const response = await routes['/api/v1/terminals'].GET(request(url), url);

    expect(response.status).toBe(401);
  });

  it('passes the server-derived principal through every control operation', async () => {
    const calls = [];
    const manager = {
      list(receivedPrincipal) {
        calls.push(['list', receivedPrincipal]);
        return [metadata];
      },
      async create(receivedPrincipal, input) {
        calls.push(['create', receivedPrincipal, input]);
        return { success: true, terminal: metadata };
      },
      async terminate(receivedPrincipal, terminalId, requestId) {
        calls.push(['terminate', receivedPrincipal, terminalId, requestId]);
        return { success: true, terminalId, terminal: metadata };
      },
    };
    const routes = createTerminalRoutes(manager);
    const url = new URL('http://localhost/api/v1/terminals');
    const context = { principal };

    const listResponse = await routes['/api/v1/terminals'].GET(
      request(url),
      url,
      undefined,
      context,
    );
    const createResponse = await routes['/api/v1/terminals'].POST(
      request(url, 'POST', {
        requestId: 'create-1',
        requestedInitialWorkingDirectory: '/workspace',
      }),
      url,
      undefined,
      context,
    );
    const terminateResponse = await routes['/api/v1/terminals'].DELETE(
      request(url, 'DELETE', {
        terminalId: 'terminal-1',
        requestId: 'terminate-1',
      }),
      url,
      undefined,
      context,
    );

    expect(listResponse.status).toBe(200);
    expect(createResponse.status).toBe(201);
    expect(terminateResponse.status).toBe(200);
    expect(calls).toEqual([
      ['list', principal],
      [
        'create',
        principal,
        {
          requestId: 'create-1',
          requestedInitialWorkingDirectory: '/workspace',
        },
      ],
      ['terminate', principal, 'terminal-1', 'terminate-1'],
    ]);
  });

  it('returns stable typed validation and manager errors', async () => {
    const manager = {
      list: () => [],
      create: async () => {
        throw new TerminalManagerError('terminal-limit', 'Limit reached.', 409);
      },
    };
    const routes = createTerminalRoutes(manager);
    const url = new URL('http://localhost/api/v1/terminals');
    const invalid = await routes['/api/v1/terminals'].POST(
      request(url, 'POST', { requestId: '' }),
      url,
      undefined,
      { principal },
    );
    const limited = await routes['/api/v1/terminals'].POST(
      request(url, 'POST', {
        requestId: 'create-1',
        requestedInitialWorkingDirectory: null,
      }),
      url,
      undefined,
      { principal },
    );

    expect(invalid.status).toBe(400);
    expect((await invalid.json()).errorCode).toBe('terminal-validation');
    expect(limited.status).toBe(409);
    expect((await limited.json()).errorCode).toBe('terminal-limit');
  });
});
