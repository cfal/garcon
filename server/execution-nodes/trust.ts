import { isIP } from 'node:net';
import type { RequestIpServer } from '../lib/rate-limit.js';

export interface NodeEnrollmentTransportOptions {
  readonly listenerUsesTls: boolean;
  readonly trustedProxyAddresses?: readonly string[];
}

export class NodeEnrollmentTransport {
  readonly #trustedProxies: ReadonlySet<string>;
  readonly #listenerUsesTls: boolean;

  constructor(options: NodeEnrollmentTransportOptions) {
    this.#trustedProxies = new Set((options.trustedProxyAddresses ?? []).map((address) => {
      const normalized = proxyAddress(address);
      if (!normalized) throw new TypeError('Trusted enrollment proxies must be explicit IP addresses');
      return normalized;
    }));
    this.#listenerUsesTls = options.listenerUsesTls;
  }

  isSecure(request: Request, server?: RequestIpServer): boolean {
    if (this.#listenerUsesTls && new URL(request.url).protocol === 'https:') return true;
    if (request.headers.get('x-forwarded-proto') !== 'https') return false;
    const peer = nodeEnrollmentPeerAddress(request, server);
    return peer !== null && this.#trustedProxies.has(peer);
  }
}

export function nodeEnrollmentPeerAddress(request: Request, server?: RequestIpServer): string | null {
  try {
    const peer = server?.requestIP?.(request)?.address;
    return typeof peer === 'string' ? proxyAddress(peer) : null;
  } catch { return null; }
}

function proxyAddress(address: string): string | null {
  const version = isIP(address);
  if (!version) return null;
  try {
    // IPv4 and IPv4-mapped IPv6 peers share the same canonical URL literal.
    return new URL(`http://[${version === 4 ? '::ffff:' : ''}${address}]`).hostname;
  } catch { return null; }
}
