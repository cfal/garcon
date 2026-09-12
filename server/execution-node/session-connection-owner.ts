import { isExecutionIdentity } from '../../common/execution-location.js';
import type { NodeHostedConnection, NodeSessionCoordinator } from './session-coordinator.js';
import { NodeAuthorityError } from './supervisor.js';

/** Selects reconnect versus fresh authority within one already-paired controller namespace. */
export class NodeSessionConnectionOwner {
  #connection: NodeHostedConnection | null = null;
  #connecting = false;

  constructor(private readonly coordinator: Pick<NodeSessionCoordinator, 'initialize' | 'supervisor' | 'open' | 'attach'>) {}

  async connect(controllerBootId: string, signal: AbortSignal): Promise<NodeHostedConnection> {
    signal.throwIfAborted();
    if (!isExecutionIdentity(controllerBootId) || this.#connecting) throw unavailable();
    this.#connecting = true;
    try {
      await this.coordinator.initialize();
      signal.throwIfAborted();
      this.coordinator.supervisor.poll();
      const previous = this.#connection;
      if (previous && previous.lease.session.controllerBootId !== controllerBootId && !previous.lease.authoritySignal.aborted) {
        if (!await this.coordinator.supervisor.revoke()) throw unavailable();
      }
      signal.throwIfAborted();
      if (this.coordinator.supervisor.status === 'cleaning-up' && !await this.coordinator.supervisor.retryCleanup()) throw unavailable();
      signal.throwIfAborted();
      const connection = previous && !previous.lease.authoritySignal.aborted
        ? this.coordinator.attach(previous.lease.session) : this.coordinator.open(controllerBootId);
      this.#connection = connection;
      return connection;
    } finally { this.#connecting = false; }
  }
}

function unavailable(): NodeAuthorityError { return new NodeAuthorityError('NODE_UNAVAILABLE', 'Execution node connection is unavailable'); }
