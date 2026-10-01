// Sliding-window rate limiter keyed by client IP.
// Each limiter tracks request timestamps per IP and rejects requests
// that exceed the configured threshold within the window.

import { isTrustProxyEnabled } from '../config.js';
import { jsonError } from '../../common/http-error.js';

interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
}

export interface RequestIpServer {
  requestIP?: (request: Request) => { address?: string | null } | null;
}

export interface RateLimiter {
  check(request: Request, server?: RequestIpServer | null): Response | null;
  dispose(): void;
}

function getForwardedClientIp(request: Request): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || null;
}

function getSocketClientIp(request: Request, server?: RequestIpServer | null): string | null {
  try {
    return server?.requestIP?.(request)?.address || null;
  } catch {
    return null;
  }
}

function getClientIp(request: Request, server?: RequestIpServer | null): string {
  if (isTrustProxyEnabled()) {
    return getForwardedClientIp(request) || getSocketClientIp(request, server) || 'unknown';
  }
  return getSocketClientIp(request, server) || 'unknown';
}

export function createRateLimiter({ windowMs = 60_000, maxRequests = 10 }: RateLimiterOptions = {}): RateLimiter {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError('Rate limits require a nonnegative integer threshold and a positive finite window');
  }
  const hits = new Map<string, number[]>();

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
  sweepInterval.unref?.();

  return {
    // Returns a 429 Response if the limit is exceeded, or null if allowed.
    check(request: Request, server?: RequestIpServer | null): Response | null {
      const ip = getClientIp(request, server);
      const now = Date.now();
      const cutoff = now - windowMs;
      const timestamps = (hits.get(ip) || []).filter((t) => t > cutoff);
      const exceeded = timestamps.length >= maxRequests;
      timestamps.push(now);
      // Rejected attempts still extend the cooldown; older hits cannot change admission.
      if (timestamps.length > maxRequests) timestamps.splice(0, timestamps.length - maxRequests);
      hits.set(ip, timestamps);

      if (exceeded) {
        return jsonError('Too many requests. Please try again later.', 429, 'RATE_LIMITED', true);
      }
      return null;
    },
    dispose(): void {
      clearInterval(sweepInterval);
      hits.clear();
    },
  };
}
