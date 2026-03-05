import { describe, it, expect } from 'bun:test';
import {
  cacheHeaders,
} from '../static.js';

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
