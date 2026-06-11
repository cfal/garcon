import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createRateLimiter } from '../rate-limit.js';

const originalTrustProxy = process.env.GARCON_TRUST_PROXY;

afterEach(() => {
  if (originalTrustProxy === undefined) {
    delete process.env.GARCON_TRUST_PROXY;
  } else {
    process.env.GARCON_TRUST_PROXY = originalTrustProxy;
  }
});

function requestWithHeaders(headers = {}) {
  return new Request('http://localhost/api/v1/auth/login', { headers });
}

function serverForAddress(address) {
  return {
    requestIP: mock(() => ({ address, family: 'IPv4', port: 1234 })),
  };
}

describe('createRateLimiter', () => {
  it('keys direct requests by socket address instead of spoofable headers', async () => {
    delete process.env.GARCON_TRUST_PROXY;
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const server = serverForAddress('127.0.0.1');

    const first = limiter.check(requestWithHeaders({ 'x-forwarded-for': '10.0.0.1' }), server);
    const second = limiter.check(requestWithHeaders({ 'x-forwarded-for': '10.0.0.2' }), server);

    expect(first).toBeNull();
    expect(second?.status).toBe(429);
  });

  it('uses forwarded headers only when proxy trust is enabled', async () => {
    process.env.GARCON_TRUST_PROXY = 'true';
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const server = serverForAddress('127.0.0.1');

    const first = limiter.check(requestWithHeaders({ 'x-forwarded-for': '10.0.0.1' }), server);
    const second = limiter.check(requestWithHeaders({ 'x-forwarded-for': '10.0.0.2' }), server);

    expect(first).toBeNull();
    expect(second).toBeNull();
  });

  it('falls back to the socket address when trusted proxy headers are absent', async () => {
    process.env.GARCON_TRUST_PROXY = 'true';
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const server = serverForAddress('127.0.0.1');

    const first = limiter.check(requestWithHeaders(), server);
    const second = limiter.check(requestWithHeaders(), server);

    expect(first).toBeNull();
    expect(second?.status).toBe(429);
  });
});
