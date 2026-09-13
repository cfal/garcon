import { isExecutionIdentity } from '../../common/execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../common/node-operation.js';
import { MAX_NODE_HISTORY_OPERATIONS } from './transport/provider-history-wire.js';

export interface NodeHistoryOperationLease {
  readonly operationId: string;
  readonly after: number;
  release(): void;
}

interface InstanceOperations {
  issued: number;
  readonly outstanding: Set<number>;
}

/** Issues per-instance ordinals for one logical session, shared by facets and physical connections. */
export class NodeHistoryOperationIssuer {
  readonly #instances = new Map<string, InstanceOperations>();
  readonly #session: NodeSessionIdentity;
  #closed = false;

  constructor(session: NodeSessionIdentity, instanceIds: Iterable<string>) {
    const captured = parseNodeSessionIdentity(session);
    if (!captured) throw new TypeError('Invalid history operation session');
    this.#session = Object.freeze(captured);
    for (const instanceId of instanceIds) {
      if (!isExecutionIdentity(instanceId) || this.#instances.has(instanceId)) throw new TypeError('Invalid history operation instance');
      this.#instances.set(instanceId, { issued: 0, outstanding: new Set() });
    }
  }

  allocate(session: NodeSessionIdentity, instanceId: string): NodeHistoryOperationLease | null {
    const instance = this.#instances.get(instanceId);
    if (this.#closed || !sameNodeSession(session, this.#session) || !instance
      || instance.outstanding.size >= MAX_NODE_HISTORY_OPERATIONS) return null;
    const ordinal = instance.issued + 1;
    if (!Number.isSafeInteger(ordinal)) return null;
    let after = ordinal - 1;
    for (const outstanding of instance.outstanding) after = Math.min(after, outstanding - 1);
    instance.issued = ordinal;
    instance.outstanding.add(ordinal);
    return Object.freeze({ operationId: String(ordinal), after, release() { instance.outstanding.delete(ordinal); } });
  }

  close(): void {
    this.#closed = true;
    this.#instances.clear();
  }
}
