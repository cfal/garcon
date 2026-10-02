import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
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
  it('rejects unbounded or fractional settings and permits an explicit zero threshold', () => {
    for (const maxRequests of [-1, 0.5, NaN, Infinity]) expect(() => createRateLimiter({ maxRequests })).toThrow(RangeError);
    for (const windowMs of [0, -1, NaN, Infinity]) expect(() => createRateLimiter({ windowMs })).toThrow(RangeError);
    for (const maxTrackedIps of [0, -1, 0.5, NaN, Infinity]) expect(() => createRateLimiter({ maxTrackedIps })).toThrow(RangeError);
    const limiter = createRateLimiter({ maxRequests: 0 });
    try { expect(limiter.check(requestWithHeaders())?.status).toBe(429); }
    finally { limiter.dispose(); }
  });

  it('fails closed for new keys at capacity without resetting existing quotas', () => {
    const now = spyOn(Date, 'now').mockReturnValue(0);
    const limiter = createRateLimiter({ windowMs: 1_000, maxRequests: 2, maxTrackedIps: 2 });
    const check = ip => limiter.check(requestWithHeaders(), serverForAddress(ip));
    try {
      expect(check('first')).toBeNull();
      expect(check('second')).toBeNull();
      for (let index = 0; index < 100; index++) expect(check(`unseen-${index}`)?.status).toBe(429);
      expect(check('first')).toBeNull();
      expect(check('first')?.status).toBe(429);
      now.mockReturnValue(900);
      expect(check('second')).toBeNull();
      expect(check('new')?.status).toBe(429);
      now.mockReturnValue(1_000);
      expect(check('new')).toBeNull();
      expect(check('first')?.status).toBe(429);
      expect(check('second')).toBeNull();
      expect(check('second')?.status).toBe(429);
      now.mockReturnValue(2_000);
      expect(check('first')).toBeNull();
    } finally { now.mockRestore(); limiter.dispose(); }
  });

  it('retains only the threshold of recent attempts under a sustained rejected burst', () => {
    const now = spyOn(Date, 'now').mockReturnValue(1_000);
    const originalFilter = Array.prototype.filter;
    let largest = 0;
    const filter = spyOn(Array.prototype, 'filter').mockImplementation(function (...args) {
      largest = Math.max(largest, this.length);
      return originalFilter.apply(this, args);
    });
    const limiter = createRateLimiter({ windowMs: 1_000, maxRequests: 10 });
    const request = requestWithHeaders();
    let rejected = 0;
    try {
      for (let index = 0; index < 2_000; index++) if (limiter.check(request)) rejected++;
      filter.mockRestore();
      expect(rejected).toBe(1_990);
      expect(largest).toBeLessThanOrEqual(10);
    } finally { filter.mockRestore(); now.mockRestore(); limiter.dispose(); }
  });

  it('preserves rejected-attempt cooldown and expires hits at the exact window boundary', () => {
    const now = spyOn(Date, 'now').mockReturnValue(0);
    const limiter = createRateLimiter({ windowMs: 1_000, maxRequests: 2 });
    const request = requestWithHeaders();
    try {
      expect(limiter.check(request)).toBeNull();
      expect(limiter.check(request)).toBeNull();
      now.mockReturnValue(900);
      expect(limiter.check(request)?.status).toBe(429);
      now.mockReturnValue(1_000);
      expect(limiter.check(request)).toBeNull();
      now.mockReturnValue(1_899);
      expect(limiter.check(request)?.status).toBe(429);
      now.mockReturnValue(2_000);
      expect(limiter.check(request)).toBeNull();
    } finally { now.mockRestore(); limiter.dispose(); }
  });

  it('keys direct requests by socket address instead of spoofable headers', async () => {
    delete process.env.GARCON_TRUST_PROXY;
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const server = serverForAddress('127.0.0.1');

    const first = limiter.check(requestWithHeaders({ 'x-forwarded-for': '10.0.0.1' }), server);
    const second = limiter.check(requestWithHeaders({ 'x-forwarded-for': '10.0.0.2' }), server);

    expect(first).toBeNull();
    expect(second?.status).toBe(429);
    limiter.dispose();
  });

  it('uses forwarded headers only when proxy trust is enabled', async () => {
    process.env.GARCON_TRUST_PROXY = 'true';
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const server = serverForAddress('127.0.0.1');

    const first = limiter.check(requestWithHeaders({ 'x-forwarded-for': '10.0.0.1' }), server);
    const second = limiter.check(requestWithHeaders({ 'x-forwarded-for': '10.0.0.2' }), server);

    expect(first).toBeNull();
    expect(second).toBeNull();
    limiter.dispose();
  });

  it('falls back to the socket address when trusted proxy headers are absent', async () => {
    process.env.GARCON_TRUST_PROXY = 'true';
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const server = serverForAddress('127.0.0.1');

    const first = limiter.check(requestWithHeaders(), server);
    const second = limiter.check(requestWithHeaders(), server);

    expect(first).toBeNull();
    expect(second?.status).toBe(429);
    limiter.dispose();
  });

  it('clears its sweep interval when disposed', () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const timer = { unref: mock(() => undefined) };
    const clearInterval = mock(() => undefined);
    globalThis.setInterval = mock(() => timer);
    globalThis.clearInterval = clearInterval;

    try {
      const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
      limiter.dispose();

      expect(timer.unref).toHaveBeenCalledTimes(1);
      expect(clearInterval).toHaveBeenCalledWith(timer);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
});
