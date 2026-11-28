// A stand-in controller for the harness's own tests. It prints the readiness
// line the harness waits for and answers a few routes with values that change
// from one start to the next, as the original's do.
const things = new Map<string, string>();
const authDisabled = process.argv.includes('--disable-auth');

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/api/v1/auth/login') {
      // As the original, it signs nobody in while authentication is disabled.
      if (authDisabled) {
        return Response.json({ success: false, error: 'Authentication is disabled by server configuration', errorCode: 'AUTH_CHANGE_FORBIDDEN', retryable: false }, { status: 403 });
      }
      return Response.json({ token: 'probe-session-token' });
    }
    if (path === '/api/v1/auth/status') return Response.json({ needsSetup: false, isAuthenticated: authDisabled, authDisabled });
    if (path === '/api/v1/app/settings' && process.argv.includes('--settings-unported')) {
      const marked = request.method !== 'GET' || !process.argv.includes('--unmarked-settings-get');
      return new Response(null, { status: 501, headers: marked ? { 'X-Garcon-Rs-Unported': '1' } : {} });
    }
    if (path === '/api/v1/path') {
      return new Response(process.env.PATH ?? '', { headers: { 'Content-Type': 'text/plain' } });
    }
    if (path === '/api/v1/days') {
      return Response.json({ since: url.searchParams.get('since'), today: new Date().toISOString().slice(0, 10) });
    }
    if (path === '/api/v1/large') {
      return Response.json({ baseUrl: url.origin, createdAt: new Date().toISOString(), text: 'x'.repeat(70_000) });
    }
    if (path === '/api/v1/things' && request.method === 'POST') {
      const id = crypto.randomUUID();
      const body = (await request.json()) as { name?: string };
      things.set(id, String(body.name ?? ''));
      return Response.json({ id, name: things.get(id) }, { status: 201 });
    }
    const thing = /^\/api\/v1\/things\/([^/]+)$/.exec(path);
    if (thing && request.method === 'PATCH') {
      if (!things.has(thing[1]!)) return new Response('Not found', { status: 404 });
      return Response.json({ id: thing[1], name: request.headers.get('x-name') });
    }
    if (path === '/api/v1/things' && request.method === 'GET') {
      const proof = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      return Response.json({ items: [...things].map(([id]) => ({ id })), proof });
    }
    return new Response('Not found', { status: 404 });
  },
});
console.log(`Started at http://127.0.0.1:${server.port}`);
