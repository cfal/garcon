import { DomainError } from '../lib/domain-error.js';
import type { RequestIpServer } from '../lib/rate-limit.js';
import type { NodePairingStore, PairedNodeConnection, PairedNodePrincipal } from './pairing-store.js';
import { nodeEnrollmentPeerAddress, type NodeEnrollmentTransport } from './trust.js';
import { nodeChannelKind, type NodeChannelKind } from './transport/channel-path.js';

// Two socket kinds intentionally allow 32 handshakes, 120 attempts/minute globally and 20 per peer.
export const MAX_NODE_CHANNEL_HANDSHAKES = 16;
export const MAX_NODE_CHANNEL_ATTEMPTS_PER_MINUTE = 60;
export const MAX_NODE_CHANNEL_ATTEMPTS_PER_PEER_PER_MINUTE = 10;

export interface AuthenticatedNodeChannel extends PairedNodeConnection {
  readonly kind: NodeChannelKind;
  releaseHandshake(): void;
}

export interface NodeChannelAuthenticationOptions {
  readonly pairings: Pick<NodePairingStore, 'authenticateConnection'>;
  readonly transport: Pick<NodeEnrollmentTransport, 'isSecure'>;
  readonly now?: () => number;
  /** Checks enabled administration and the still-configured remote node on every authority use. */
  authorize(principal: PairedNodePrincipal): void;
}

/** Reserves bounded handshakes separately from account/local routes and their principals. */
export class NodeChannelAuthentication {
  readonly #budgets: Record<NodeChannelKind, { active: number; attempts: { at: number; peer: string }[] }> = {
    session: { active: 0, attempts: [] }, bulk: { active: 0, attempts: [] },
  };
  #lastTime = 0;

  constructor(private readonly options: NodeChannelAuthenticationOptions) {}

  authenticate(request: Request, server?: RequestIpServer): AuthenticatedNodeChannel {
    const url = new URL(request.url);
    const kind = nodeChannelKind(url.pathname);
    if (!kind || url.search || request.method !== 'GET'
      || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw rejected();
    if (!this.options.transport.isSecure(request, server)) throw new DomainError('NODE_TLS_REQUIRED', 'Node channels require verified HTTPS transport', 403);
    const now = (this.options.now ?? (() => performance.now()))();
    if (!Number.isFinite(now) || now < this.#lastTime) throw new DomainError('NODE_UNAVAILABLE', 'Node channel admission is unavailable', 503);
    this.#lastTime = now;
    const peer = nodeEnrollmentPeerAddress(request, server) ?? 'unknown';
    const budget = this.#budgets[kind];
    budget.attempts = budget.attempts.filter(({ at }) => now - at < 60_000);
    if (budget.active >= MAX_NODE_CHANNEL_HANDSHAKES || budget.attempts.length >= MAX_NODE_CHANNEL_ATTEMPTS_PER_MINUTE
      || budget.attempts.filter((attempt) => attempt.peer === peer).length >= MAX_NODE_CHANNEL_ATTEMPTS_PER_PEER_PER_MINUTE) {
      throw new DomainError('NODE_CAPACITY', 'Too many node channel handshakes', 429, true);
    }
    budget.attempts.push({ at: now, peer });
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Garcon-Node ')) throw rejected();
    const authority = this.options.pairings.authenticateConnection(header.slice('Garcon-Node '.length));
    if (!authority) throw rejected();
    this.options.authorize(authority.principal);
    budget.active++;
    let released = false;
    return Object.freeze({ kind, principal: authority.principal,
      validate: () => { authority.validate(); this.options.authorize(authority.principal); },
      releaseHandshake: () => { if (!released) { released = true; budget.active--; } },
    });
  }
}

function rejected(): DomainError { return new DomainError('NODE_UNAUTHORIZED', 'Node channel authentication failed', 401); }
