import { describe, it, expect, mock, beforeEach } from 'bun:test';

const authenticateHttpRequest = mock(() => Promise.resolve({ user: { username: 'alice' }, errorResponse: null }));

mock.module('../http-native.js', () => ({
  authenticateHttpRequest,
}));

import { markRouteNoAuth, isNoAuthHandler, wrapRoute, wrapRoutes } from '../route-auth.js';

describe('route auth wrapping', () => {
  beforeEach(() => {
    authenticateHttpRequest.mockClear();
  });

  it('requires auth for unmarked handlers', async () => {
    const handler = mock((_req, _url, user) => Response.json({ username: user.username }));
    const wrapped = wrapRoute(handler, '/api/private', 'GET');
    const response = await wrapped(new Request('http://localhost/api/private'));
    const payload = await response.json();

    expect(authenticateHttpRequest).toHaveBeenCalledTimes(1);
    expect(payload.username).toBe('alice');
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
    const noauthByNameOnly = function noauthAccidentalByName(_req, _url, user) {
      return Response.json({ username: user.username });
    };
    const wrapped = wrapRoute(noauthByNameOnly, '/api/private', 'GET');
    const response = await wrapped(new Request('http://localhost/api/private'));
    const payload = await response.json();

    expect(authenticateHttpRequest).toHaveBeenCalledTimes(1);
    expect(payload.username).toBe('alice');
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
      '/api/private': { POST: (_req, _url, user) => Response.json({ username: user.username }) },
    };
    const wrappedRoutes = wrapRoutes(rawRoutes);

    const publicResponse = await wrappedRoutes['/api/public'].GET(new Request('http://localhost/api/public'));
    const privateResponse = await wrappedRoutes['/api/private'].POST(new Request('http://localhost/api/private'));

    expect((await publicResponse.json()).public).toBe(true);
    expect((await privateResponse.json()).username).toBe('alice');
    expect(authenticateHttpRequest).toHaveBeenCalledTimes(1);
  });
});
