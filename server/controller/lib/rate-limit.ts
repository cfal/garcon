// Sliding-window rate limiter keyed by client IP.
// Each limiter tracks request timestamps per IP and rejects requests
// that exceed the configured threshold within the window.

import { isTrustProxyEnabled } from '../config.js';
import { jsonError } from '../../common/http-error.js';

interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
  maxTrackedIps?: number;
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

export function createRateLimiter({ windowMs = 60_000, maxRequests = 10, maxTrackedIps = 10_000 }: RateLimiterOptions = {}): RateLimiter {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0 || !Number.isFinite(windowMs) || windowMs <= 0
    || !Number.isSafeInteger(maxTrackedIps) || maxTrackedIps <= 0) {
    throw new RangeError('Rate limits require a nonnegative integer threshold, a positive finite window and a positive integer IP capacity');
  }
  const hits = new Map<string, number[]>();

  function purgeExpired(cutoff: number): void {
    // Entries are ordered by their most recent attempt, so active keys stop the scan.
    for (const [ip, timestamps] of hits) {
      if (timestamps[timestamps.length - 1] > cutoff) break;
      hits.delete(ip);
    }
  }

  function rejected(): Response {
    return jsonError('Too many requests. Please try again later.', 429, 'RATE_LIMITED', true);
  }

  const sweepInterval = setInterval(() => purgeExpired(Date.now() - windowMs), 120_000);
  sweepInterval.unref?.();

  return {
    // Returns a 429 Response if the limit is exceeded, or null if allowed.
    check(request: Request, server?: RequestIpServer | null): Response | null {
      const ip = getClientIp(request, server);
      const now = Date.now();
      const cutoff = now - windowMs;
      if (maxRequests === 0) return rejected();
      if (!hits.has(ip) && hits.size >= maxTrackedIps) {
        purgeExpired(cutoff);
        // Evicting an active key would reset its quota and permit bypass.
        if (hits.size >= maxTrackedIps) return rejected();
      }
      const timestamps = (hits.get(ip) || []).filter((t) => t > cutoff);
      const exceeded = timestamps.length >= maxRequests;
      timestamps.push(now);
      // Rejected attempts still extend the cooldown; older hits cannot change admission.
      if (timestamps.length > maxRequests) timestamps.splice(0, timestamps.length - maxRequests);
      hits.delete(ip);
      hits.set(ip, timestamps);

      if (exceeded) {
        return rejected();
      }
      return null;
    },
    dispose(): void {
      clearInterval(sweepInterval);
      hits.clear();
    },
  };
}
