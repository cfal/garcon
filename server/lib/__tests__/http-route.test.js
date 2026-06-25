import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const authenticateHttpRequest = mock(() => Promise.resolve({ errorResponse: null }));
const isAuthDisabled = mock(() => false);
const isHttpCompressionEnabled = mock(() => true);
const parseJsonBody = mock(() => Promise.resolve({ ok: true }));
class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

async function decodeDeflate(bytes) {
  if (typeof DecompressionStream !== 'function') {
    return new TextDecoder().decode(Bun.inflateSync(bytes));
  }
  // Uses Web decompression when available to match CompressionStream('deflate') output.
  return new Response(
    new Response(bytes).body.pipeThrough(new DecompressionStream('deflate')),
  ).text();
}

mock.module('../http-request.js', () => ({
  authenticateHttpRequest,
  MalformedJsonError,
  parseJsonBody,
}));
mock.module('../../config.js', () => ({
  isAuthDisabled,
  isHttpCompressionEnabled,
}));

import { markRouteNoAuth, isNoAuthHandler, wrapRoute, wrapRoutes } from '../http-route.js';
import { withJsonBody } from '../json-route.js';

function resetConfigMocks() {
  isAuthDisabled.mockReset();
  isAuthDisabled.mockReturnValue(false);
  isHttpCompressionEnabled.mockReset();
  isHttpCompressionEnabled.mockReturnValue(true);
}

describe('http route wrapping', () => {
  beforeEach(() => {
    authenticateHttpRequest.mockClear();
    parseJsonBody.mockClear();
    resetConfigMocks();
  });

  afterEach(() => {
    resetConfigMocks();
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

  it('compresses wrapped route responses with Accept-Encoding: gzip', async () => {
    const handler = markRouteNoAuth(() => Response.json({ ok: true }));
    const wrapped = wrapRoute(handler, '/api/public', 'GET');
    const response = await wrapped(
      new Request('http://localhost/api/public', { headers: { 'Accept-Encoding': 'gzip' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    const decoded = Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(JSON.parse(new TextDecoder().decode(decoded)).ok).toBe(true);
  });

  it('compresses wrapped route responses with Accept-Encoding: zstd', async () => {
    const handler = markRouteNoAuth(() => Response.json({ ok: true }));
    const wrapped = wrapRoute(handler, '/api/public', 'GET');
    const response = await wrapped(
      new Request('http://localhost/api/public', { headers: { 'Accept-Encoding': 'zstd' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBe('zstd');
    const decoded = Bun.zstdDecompressSync(new Uint8Array(await response.arrayBuffer()));
    expect(JSON.parse(new TextDecoder().decode(decoded)).ok).toBe(true);
  });

  it('compresses wrapped route responses with Accept-Encoding: deflate', async () => {
    const handler = markRouteNoAuth(() => Response.json({ ok: true }));
    const wrapped = wrapRoute(handler, '/api/public', 'GET');
    const response = await wrapped(
      new Request('http://localhost/api/public', { headers: { 'Accept-Encoding': 'deflate' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBe('deflate');
    const decoded = await decodeDeflate(new Uint8Array(await response.arrayBuffer()));
    expect(JSON.parse(decoded).ok).toBe(true);
  });

  it('does not compress wrapped route responses with Accept-Encoding: br', async () => {
    const handler = markRouteNoAuth(() => Response.json({ ok: true }));
    const wrapped = wrapRoute(handler, '/api/public', 'GET');
    const response = await wrapped(
      new Request('http://localhost/api/public', { headers: { 'Accept-Encoding': 'br' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    expect((await response.json()).ok).toBe(true);
  });

  it('does not compress when HTTP compression is disabled by config', async () => {
    isHttpCompressionEnabled.mockReturnValue(false);
    const handler = markRouteNoAuth(() => Response.json({ ok: true }));
    const wrapped = wrapRoute(handler, '/api/public', 'GET');
    const response = await wrapped(
      new Request('http://localhost/api/public', { headers: { 'Accept-Encoding': 'gzip' } }),
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(response.headers.get('Vary')).toBeNull();
  });
});
