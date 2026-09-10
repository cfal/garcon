import {
  MAX_NODE_ENROLLMENT_EXCHANGE_BYTES, parseNodeEnrollmentIssueRequest, parseNodeEnrollmentRequest,
} from '../../common/execution-node-config.js';
import type { NodeEnrollmentService } from '../execution-nodes/enrollment.js';
import { readNodeEnrollmentBody } from '../execution-nodes/enrollment-body.js';
import { nodeEnrollmentPeerAddress, type NodeEnrollmentTransport } from '../execution-nodes/trust.js';
import { DomainError } from '../lib/domain-error.js';
import { jsonError } from '../lib/http-error.js';
import { markRouteNoAuth } from '../lib/http-route.js';
import type { HttpRouteContext, RouteHandler, RouteMap } from '../lib/http-route-types.js';
import type { RequestIpServer } from '../lib/rate-limit.js';
import { AtomicJsonWriteError } from '../lib/json-file-store.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('node-enrollment');

export const MAX_CONCURRENT_NODE_ENROLLMENTS = 8;
export const MAX_NODE_ENROLLMENTS_PER_MINUTE = 60;
export const MAX_CONCURRENT_NODE_ENROLLMENTS_PER_PEER = 2;
export const MAX_NODE_ENROLLMENTS_PER_PEER_PER_MINUTE = 10;

export function createNodeEnrollmentRoutes(options: {
  readonly enrollment: Pick<NodeEnrollmentService, 'issue' | 'enroll'>;
  readonly transport: Pick<NodeEnrollmentTransport, 'isSecure'>;
  readonly now?: () => number;
}): RouteMap {
  const now = options.now ?? Date.now;
  const route = (
    kind: 'issue' | 'exchange',
    action: (body: unknown, context?: HttpRouteContext) => Promise<unknown>,
    fallback: DomainError,
  ): RouteHandler => {
    let active = 0;
    let starts: { readonly at: number; readonly peer: string | null }[] = [];
    const activePeers = new Map<string, number>();
    return async (request, url, server, context) => {
      let admitted = false;
      const peer = kind === 'exchange' ? nodeEnrollmentPeerAddress(request, server as RequestIpServer | undefined) ?? 'unknown' : null;
      try {
        if (!options.transport.isSecure(request, server as RequestIpServer | undefined)) {
          throw new DomainError('NODE_TLS_REQUIRED', 'Node enrollment requires HTTPS or an explicitly trusted TLS proxy', 403);
        }
        if (url.search) throw new DomainError('NODE_ENROLLMENT_INVALID', 'Node enrollment does not accept query parameters', 400);
        const time = now();
        starts = starts.filter(({ at }) => time - at < 60_000);
        const peerActive = peer === null ? 0 : activePeers.get(peer) ?? 0;
        if (active >= MAX_CONCURRENT_NODE_ENROLLMENTS || starts.length >= MAX_NODE_ENROLLMENTS_PER_MINUTE
          || (peer !== null && (peerActive >= MAX_CONCURRENT_NODE_ENROLLMENTS_PER_PEER
            || starts.filter((entry) => entry.peer === peer).length >= MAX_NODE_ENROLLMENTS_PER_PEER_PER_MINUTE))) {
          throw new DomainError('NODE_PAIRING_CAPACITY', 'Too many node enrollment requests; try again later', 429, true);
        }
        starts.push({ at: time, peer });
        active += 1;
        if (peer !== null) activePeers.set(peer, peerActive + 1);
        admitted = true;
        const body = await readNodeEnrollmentBody(request, MAX_NODE_ENROLLMENT_EXCHANGE_BYTES);
        request.signal.throwIfAborted();
        return privateResponse(Response.json(await action(body, context)));
      } catch (error) {
        const failure = error instanceof DomainError ? error
          : error instanceof AtomicJsonWriteError && error.renamed
            ? new DomainError('NODE_PAIRING_UNAVAILABLE', 'Node credential durability is unknown; restart the controller before continuing', 503)
            : fallback;
        if (!(error instanceof DomainError) && !request.signal.aborted) {
          // Arbitrary error messages can contain enrollment credentials.
          logger.error('Node enrollment failed', {
            operation: kind, errorCode: failure.code,
            durability: error instanceof AtomicJsonWriteError ? error.renamed ? 'renamed-unconfirmed' : 'not-renamed' : 'unconfirmed',
          });
        }
        return privateResponse(jsonError(failure.message, failure.status, failure.code, failure.retryable));
      } finally {
        if (admitted) {
          active -= 1;
          if (peer !== null) {
            const remaining = activePeers.get(peer)! - 1;
            if (remaining === 0) activePeers.delete(peer);
            else activePeers.set(peer, remaining);
          }
        }
      }
    };
  };

  return {
    '/api/v1/execution-nodes/enrollment': {
      POST: route('issue', async (body, context) => {
        const parsed = parseNodeEnrollmentIssueRequest(body);
        if (!parsed) throw new DomainError('NODE_ENROLLMENT_INVALID', 'Invalid node enrollment configuration', 400);
        return options.enrollment.issue(parsed, context?.principal ?? null);
      }, new DomainError('NODE_PAIRING_UNAVAILABLE', 'Node enrollment could not be issued; try again later', 503, true)),
    },
    '/api/v1/execution-nodes/enroll': {
      POST: markRouteNoAuth(route('exchange', async (body) => {
        const parsed = parseNodeEnrollmentRequest(body);
        if (!parsed) throw new DomainError('NODE_ENROLLMENT_INVALID', 'Invalid node enrollment request', 400);
        return options.enrollment.enroll(parsed);
      }, new DomainError('NODE_PAIRING_UNAVAILABLE', 'Node enrollment could not be confirmed; revoke and reissue the bundle before retrying', 503))),
    },
  };
}

function privateResponse(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
