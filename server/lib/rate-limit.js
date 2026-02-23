// Sliding-window rate limiter keyed by client IP.
// Each limiter tracks request timestamps per IP and rejects requests
// that exceed the configured threshold within the window.


function getClientIp(request) {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

export function createRateLimiter({ windowMs = 60_000, maxRequests = 10 } = {}) {
  const hits = new Map();

  // Purge stale entries every 2 minutes to avoid unbounded growth.
  const sweepInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, timestamps] of hits) {
      const filtered = timestamps.filter((t) => t > cutoff);
      if (filtered.length === 0) {
        hits.delete(ip);
      } else {
        hits.set(ip, filtered);
      }
    }
  }, 120_000);
  if (sweepInterval.unref) sweepInterval.unref();

  return {
    // Returns a 429 Response if the limit is exceeded, or null if allowed.
    check(request) {
      const ip = getClientIp(request);
      const now = Date.now();
      const cutoff = now - windowMs;
      const timestamps = (hits.get(ip) || []).filter((t) => t > cutoff);
      timestamps.push(now);
      hits.set(ip, timestamps);

      if (timestamps.length > maxRequests) {
        return Response.json(
          { error: 'Too many requests. Please try again later.' },
          { status: 429 },
        );
      }
      return null;
    },
  };
}
