import {
  parseControllerOrigin, parseNodeEnrollmentIssueRequest, parseNodeEnrollmentRequest,
  type NodeEnrollmentBundle, type NodeEnrollmentIssueRequest, type NodeEnrollmentRequest, type NodeEnrollmentResponse,
} from '../../common/execution-node-config.js';
import { verifyControllerTlsTrust } from '../../common/controller-tls-node.js';
import type { ServerPrincipal } from '../lib/http-route-types.js';
import { DomainError } from '../lib/domain-error.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { ExecutionNodesStore } from './store.js';
import type { NodePairingStore } from './pairing-store.js';

export interface NodeEnrollmentOptions {
  readonly pairings: NodePairingStore;
  readonly nodes: Pick<ExecutionNodesStore, 'requireNode'>;
  readonly controller: Pick<NodeEnrollmentBundle, 'controllerUrl' | 'trust'>;
  isAdministrationEnabled(): Promise<boolean>;
}

export class NodeEnrollmentService {
  readonly #lock = new KeyedPromiseLock();
  readonly #controller: Pick<NodeEnrollmentBundle, 'controllerUrl' | 'trust'>;

  constructor(private readonly options: NodeEnrollmentOptions) {
    const controllerUrl = parseControllerOrigin(options.controller.controllerUrl);
    if (!controllerUrl) throw new TypeError('Node enrollment requires a configured HTTPS controller origin');
    this.#controller = { controllerUrl, trust: verifyControllerTlsTrust(options.controller.trust) };
  }

  async issue(request: NodeEnrollmentIssueRequest, principal: ServerPrincipal | null): Promise<NodeEnrollmentBundle> {
    const captured = parseNodeEnrollmentIssueRequest(request);
    const account = principal ? { ...principal } : null;
    if (!captured) throw new DomainError('VALIDATION_FAILED', 'Invalid node enrollment configuration', 400);
    return this.#lock.runExclusive(captured.nodeId, async () => {
      await this.#requireAdministration();
      requireAccount(account);
      this.#requireRemoteNode(captured.nodeId);
      await this.options.pairings.init();
      await this.#requireAdministration();
      requireAccount(account);
      this.#requireRemoteNode(captured.nodeId);
      const issued = await this.options.pairings.issueEnrollment(captured.nodeId, async () => {
        await this.#requireAdministration();
        requireAccount(account);
        this.#requireRemoteNode(captured.nodeId);
      });
      return { ...issued, ...structuredClone(this.#controller) };
    });
  }

  async enroll(request: NodeEnrollmentRequest): Promise<NodeEnrollmentResponse> {
    const captured = parseNodeEnrollmentRequest(request);
    if (!captured) throw new DomainError('NODE_ENROLLMENT_INVALID', 'Invalid node enrollment request', 400);
    return this.#lock.runExclusive(captured.nodeId, async () => {
      await this.#requireAdministration();
      this.#requireRemoteNode(captured.nodeId);
      await this.options.pairings.init();
      await this.#requireAdministration();
      this.#requireRemoteNode(captured.nodeId);
      return this.options.pairings.enroll(captured, async () => {
        await this.#requireAdministration();
        this.#requireRemoteNode(captured.nodeId);
      });
    }).catch((error: unknown) => {
      if (error instanceof DomainError && ['NODE_UNAVAILABLE', 'NODE_REMOVED', 'NODE_ENROLLMENT_INVALID'].includes(error.code)) {
        throw new DomainError('NODE_ENROLLMENT_INVALID', 'Invalid or already consumed node enrollment', 401);
      }
      throw error;
    });
  }

  async #requireAdministration(): Promise<void> {
    if (!await this.options.isAdministrationEnabled()) {
      throw new DomainError('NODE_ADMIN_REQUIRED', 'Enable controller authentication and configure an account before pairing nodes', 403);
    }
  }

  #requireRemoteNode(nodeId: string): void {
    if (this.options.nodes.requireNode(nodeId).kind !== 'remote') {
      throw new DomainError('NODE_ENROLLMENT_INVALID', 'The local execution node cannot be paired', 409);
    }
  }
}

function requireAccount(principal: ServerPrincipal | null): void {
  if (principal?.mode !== 'authenticated' || !Number.isFinite(principal.expiresAtMs) || principal.expiresAtMs <= Date.now()) {
    throw new DomainError('NODE_ADMIN_REQUIRED', 'Node enrollment requires an authenticated controller account', 403);
  }
}
