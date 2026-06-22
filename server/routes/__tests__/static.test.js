import { describe, it, expect } from 'bun:test';
import {
  cacheHeaders,
  staticHeaders,
} from '../static.js';
import routes from '../static.js';

describe('cacheHeaders', () => {
  it('returns no-cache headers for html', () => {
    expect(cacheHeaders('/index.html')).toEqual({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
  });

  it('returns immutable cache headers for static assets', () => {
    expect(cacheHeaders('/_app/immutable/chunk.js')).toEqual({
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  it('returns empty headers for unknown extension', () => {
    expect(cacheHeaders('/api/health')).toEqual({});
  });
});

describe('staticHeaders', () => {
  it('adds Content-Length to html no-cache headers', () => {
    const headers = staticHeaders('/index.html', 2048);
    expect(headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    expect(headers.get('Content-Length')).toBe('2048');
  });

  it('adds Content-Length to immutable asset headers', () => {
    const headers = staticHeaders('/_app/immutable/chunk.js', 4096);
    expect(headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(headers.get('Content-Length')).toBe('4096');
  });

  it('adds Content-Length to service worker no-cache headers', () => {
    const headers = staticHeaders('/service-worker.js', 512);
    expect(headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    expect(headers.get('Content-Length')).toBe('512');
  });
});

describe('static app routes', () => {
  it('serves the SPA shell for the bare chat route', () => {
    expect(routes['/chat']).toBeDefined();
    expect(routes['/chat']?.GET).toBeFunction();
    expect(routes['/chat/']).toBeDefined();
    expect(routes['/chat/']?.GET).toBeFunction();
  });
});
