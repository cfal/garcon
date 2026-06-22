import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test';

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

const authenticateHttpRequest = mock(() => Promise.resolve({ errorResponse: null }));
const isAuthDisabled = mock(() => true);
const isHttpCompressionEnabled = mock(() => true);

mock.module('../../lib/http-request.js', () => ({
  authenticateHttpRequest,
  MalformedJsonError,
  parseJsonBody: mock(() => undefined),
}));
mock.module('../../config.js', () => ({
  isAuthDisabled,
  isHttpCompressionEnabled,
}));

import { wrapRoute, wrapRoutes } from '../../lib/http-route.js';
import { markRouteNoAuth } from '../../lib/http-route.js';

function makeStaticRoute(dir) {
  const handler = markRouteNoAuth(async function noauthServeFile(_req, url) {
    const stripped = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
    const file = Bun.file(`${dir}/${stripped}`);
    if (!(await file.exists())) return new Response('Not found', { status: 404 });
    return new Response(file, { headers: { 'Content-Type': 'text/plain', 'Content-Length': String(file.size) } });
  });
  return handler;
}

describe('HTTP compression integration', () => {
  let dir;
  let server;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'garcon-compress-'));
    await writeFile(path.join(dir, 'sample.txt'), 'hello '.repeat(2000));
    const wrapped = wrapRoute(makeStaticRoute(dir), '/sample.txt', 'GET');
    server = Bun.serve({
      port: 0,
      fetch: async (req) => wrapped(req),
    });
  });

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('serves a gzip-compressed static asset that decodes to the file', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sample.txt`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    expect(await response.text()).toBe('hello '.repeat(2000));
  });

  it('serves a zstd-compressed static asset that decodes to the file', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sample.txt`, {
      headers: { 'Accept-Encoding': 'zstd' },
    });
    expect(response.headers.get('Content-Encoding')).toBe('zstd');
    expect(await response.text()).toBe('hello '.repeat(2000));
  });

  it('reads the current file contents after a rebuild (recompile safety)', async () => {
    const first = await fetch(`http://127.0.0.1:${server.port}/sample.txt`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(first.headers.get('Content-Encoding')).toBe('gzip');
    expect(await first.text()).toBe('hello '.repeat(2000));

    await writeFile(path.join(dir, 'sample.txt'), 'world '.repeat(2000));

    const second = await fetch(`http://127.0.0.1:${server.port}/sample.txt`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(second.headers.get('Content-Encoding')).toBe('gzip');
    expect(await second.text()).toBe('world '.repeat(2000));
  });

  it('serves an uncompressed static asset for br-only clients with Vary set', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sample.txt`, {
      headers: { 'Accept-Encoding': 'br' },
    });
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    expect(await response.text()).toBe('hello '.repeat(2000));
  });

  it('skips compression for Range requests and returns 206 with no Content-Encoding', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sample.txt`, {
      headers: { 'Accept-Encoding': 'gzip', Range: 'bytes=0-99' },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Encoding')).toBeNull();
  });
});
