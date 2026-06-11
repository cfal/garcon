import { describe, it, expect, mock, beforeEach } from 'bun:test';

const authenticateHttpRequest = mock(() => Promise.resolve({ errorResponse: null }));
const isAuthDisabled = mock(() => false);
const parseJsonBody = mock(() => Promise.resolve({ ok: true }));
class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

mock.module('../http-request.js', () => ({
  authenticateHttpRequest,
  MalformedJsonError,
  parseJsonBody,
}));
mock.module('../../config.js', () => ({
  isAuthDisabled,
}));

import { markRouteNoAuth, isNoAuthHandler, wrapRoute, wrapRoutes } from '../http-route.js';
import { withJsonBody } from '../json-route.js';

describe('http route wrapping', () => {
  beforeEach(() => {
    authenticateHttpRequest.mockClear();
    parseJsonBody.mockClear();
    isAuthDisabled.mockReset();
    isAuthDisabled.mockReturnValue(false);
  });

  it('requires auth for unmarked handlers', async () => {
    const handler = mock(() => Response.json({ ok: true }));
    const wrapped = wrapRoute(handler, '/api/private', 'GET');
    const response = await wrapped(new Request('http://localhost/api/private'));
    const payload = await response.json();

    expect(authenticateHttpRequest).toHaveBeenCalledTimes(1);
    expect(payload.ok).toBe(true);
  });

  it('passes the Bun server object through to handlers', async () => {
    const server = { requestIP: mock(() => ({ address: '127.0.0.1', family: 'IPv4', port: 1234 })) };
    const handler = mock((_request, _url, bunServer) => Response.json({ hasServer: bunServer === server }));
    const wrapped = wrapRoute(handler, '/api/private', 'GET');
    const response = await wrapped(new Request('http://localhost/api/private'), server);
    const payload = await response.json();

    expect(payload.hasServer).toBe(true);
    expect(handler).toHaveBeenCalledWith(expect.any(Request), expect.any(URL), server);
  });

  it('returns 400 for typed malformed JSON errors', async () => {
    const handler = mock(() => { throw new MalformedJsonError(); });
    const wrapped = wrapRoute(handler, '/api/private', 'POST');
    const response = await wrapped(new Request('http://localhost/api/private', { method: 'POST' }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe('Malformed JSON');
    expect(payload.success).toBe(false);
  });

  it('does not classify same-message errors as malformed JSON', async () => {
    const handler = mock(() => { throw new Error('Malformed JSON'); });
    const wrapped = wrapRoute(handler, '/api/private', 'POST');

    await expect(wrapped(new Request('http://localhost/api/private', { method: 'POST' })))
      .rejects.toThrow('Malformed JSON');
  });

  it('parses JSON once for body handlers', async () => {
    parseJsonBody.mockResolvedValue({ name: 'Ada' });
    const handler = mock((body) => Response.json({ greeting: body.name }));
    const wrapped = withJsonBody(handler);
    const response = await wrapped(new Request('http://localhost/api/private', { method: 'POST' }));
    const payload = await response.json();

    expect(payload.greeting).toBe('Ada');
    expect(handler).toHaveBeenCalledWith({ name: 'Ada' }, expect.any(Request), undefined, undefined);
  });

  it('returns 400 for typed malformed JSON in body handlers', async () => {
    parseJsonBody.mockRejectedValue(new MalformedJsonError());
    const handler = mock(() => Response.json({ ok: true }));
    const wrapped = withJsonBody(handler);
    const response = await wrapped(new Request('http://localhost/api/private', { method: 'POST' }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe('Malformed JSON');
    expect(handler).not.toHaveBeenCalled();
  });

  it('bypasses auth for marked handlers', async () => {
    const handler = markRouteNoAuth(mock(() => Response.json({ ok: true })));
    const wrapped = wrapRoute(handler, '/api/public', 'GET');
    const response = await wrapped(new Request('http://localhost/api/public'));
    const payload = await response.json();

    expect(authenticateHttpRequest).not.toHaveBeenCalled();
    expect(payload.ok).toBe(true);
  });

  it('does not bypass auth based on function name', async () => {
    const noauthByNameOnly = function noauthAccidentalByName() {
      return Response.json({ ok: true });
    };
    const wrapped = wrapRoute(noauthByNameOnly, '/api/private', 'GET');
    const response = await wrapped(new Request('http://localhost/api/private'));
    const payload = await response.json();

    expect(authenticateHttpRequest).toHaveBeenCalledTimes(1);
    expect(payload.ok).toBe(true);
  });

  it('marks handlers with explicit no-auth metadata', () => {
    const handler = () => new Response('ok');
    expect(isNoAuthHandler(handler)).toBe(false);
    markRouteNoAuth(handler);
    expect(isNoAuthHandler(handler)).toBe(true);
  });

  it('wrapRoutes applies wrapping to each route method', async () => {
    const rawRoutes = {
      '/api/public': { GET: markRouteNoAuth(() => Response.json({ public: true })) },
      '/api/private': { POST: () => Response.json({ private: true }) },
    };
    const wrappedRoutes = wrapRoutes(rawRoutes);

    const publicResponse = await wrappedRoutes['/api/public'].GET(new Request('http://localhost/api/public'));
    const privateResponse = await wrappedRoutes['/api/private'].POST(new Request('http://localhost/api/private'));

    expect((await publicResponse.json()).public).toBe(true);
    expect((await privateResponse.json()).private).toBe(true);
    expect(authenticateHttpRequest).toHaveBeenCalledTimes(1);
  });

  it('bypasses auth for all handlers when auth is globally disabled', async () => {
    isAuthDisabled.mockReturnValue(true);
    const handler = mock(() => Response.json({ ok: true }));
    const wrapped = wrapRoute(handler, '/api/private', 'GET');
    const response = await wrapped(new Request('http://localhost/api/private'));
    const payload = await response.json();

    expect(authenticateHttpRequest).not.toHaveBeenCalled();
    expect(payload.ok).toBe(true);
  });
});
