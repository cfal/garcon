import { isExecutionIdentity } from '../../common/execution-location.js';
import { parseNodeOperationIdentity, parseNodeSessionIdentity, sameNodeSession, type NodeOperationIdentity, type NodeSessionIdentity } from '../../common/node-operation.js';
import { MAX_NODE_EXECUTION_BODY_BYTES, type NodeExecutionBody } from '../execution-nodes/transport/execution-body-wire.js';
import { NodeBulkError, type NodeBulkTransfers } from '../execution-nodes/transport/bulk-transfers.js';
import { parseNodeBulkDescriptor, parseNodeBulkIdentity, type NodeBulkDescriptor, type NodeBulkIdentity } from '../execution-nodes/transport/bulk-wire.js';
import type { NodeExecutionWireCapabilities } from './execution-wire-adapter.js';
import { isNodeOperationGrant, type NodeOperationGrant } from './operation-table.js';

type BodyKind = NodeExecutionBody['kind'];

interface OperationGrant {
  readonly cancellation: AbortController;
  readonly detach: () => void;
  bodySignal(kind: BodyKind, controlId: string | null): AbortSignal;
}

interface BodyGrant {
  readonly owner: object;
  readonly operation: OperationGrant;
  readonly identity: NodeBulkIdentity;
  readonly kind: BodyKind;
  readonly controlId: string | null;
}

export interface NodeExecutionBodyGrantsOptions {
  readonly session: NodeSessionIdentity;
  readonly signal: AbortSignal;
  readonly transfers: Pick<NodeBulkTransfers, 'reserve' | 'take' | 'cancel' | 'status'>;
  readonly maxOperations?: number;
}

/** Binds each upload to a host-installed operation and exact control before allocating any private bytes. */
export class NodeExecutionBodyGrants implements Pick<NodeExecutionWireCapabilities, 'takeBody'> {
  readonly #session: NodeSessionIdentity;
  readonly #operations = new Map<string, OperationGrant>();
  readonly #consumed = new WeakSet<NodeOperationGrant>();
  readonly #bodies = new Map<string, BodyGrant>();
  readonly #detach: () => void;
  readonly #maxOperations: number;
  #closed = false;

  constructor(private readonly options: NodeExecutionBodyGrantsOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session) throw new TypeError('Invalid execution body namespace');
    this.#session = Object.freeze(session);
    this.#maxOperations = options.maxOperations ?? 16_384;
    if (!Number.isSafeInteger(this.#maxOperations) || this.#maxOperations < 1 || this.#maxOperations > 65_536) throw new TypeError('Invalid execution body grant limit');
    const close = () => this.close();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) this.close();
  }

  install(grant: NodeOperationGrant): void {
    if (!isNodeOperationGrant(grant)) throw new TypeError('Execution body requires an issued operation grant');
    const { identity, signal } = grant;
    const operationId = this.#operationId(identity);
    if (this.#consumed.has(grant) || this.#operations.has(operationId)) throw new TypeError('Execution body operation cannot be rebound');
    if (this.#operations.size >= this.#maxOperations) throw new NodeBulkError('NODE_CAPACITY', 'Execution body grant capacity exceeded');
    signal.throwIfAborted();
    this.#consumed.add(grant);
    const captured = Object.freeze({ ...identity });
    const retire = () => this.retire(captured);
    this.#operations.set(operationId, { cancellation: new AbortController(), bodySignal: (kind, controlId) => grant.bodySignal(kind, controlId),
      detach: () => signal.removeEventListener('abort', retire) });
    signal.addEventListener('abort', retire, { once: true });
  }

  reserve(
    identity: NodeOperationIdentity, kind: BodyKind, controlId: string | null, input: NodeBulkDescriptor, signal: AbortSignal,
  ): NodeBulkIdentity {
    this.prune();
    const { operation, bodySignal } = this.#require(identity, kind, controlId);
    const descriptor = parseNodeBulkDescriptor(input);
    if (!descriptor || descriptor.byteLength > MAX_NODE_EXECUTION_BODY_BYTES) throw new NodeBulkError('NODE_BULK_INVALID', 'Invalid execution body descriptor');
    const cancellation = AbortSignal.any([signal, operation.cancellation.signal, bodySignal]);
    cancellation.throwIfAborted();
    const owner = { operation, kind, controlId };
    const transfer = this.options.transfers.reserve(owner, descriptor, cancellation);
    this.#bodies.set(transfer.transferId, { ...owner, owner, identity: transfer });
    return transfer;
  }

  takeBody(body: NodeBulkIdentity, identity: NodeOperationIdentity, kind: BodyKind, controlId: string | null): Uint8Array {
    const { operation } = this.#require(identity, kind, controlId);
    const grant = this.#body(body);
    if (!grant || grant.operation !== operation || grant.kind !== kind || grant.controlId !== controlId) throw unavailable();
    const bytes = this.options.transfers.take(body, grant.owner);
    this.#bodies.delete(body.transferId);
    return bytes;
  }

  cancel(body: NodeBulkIdentity): void {
    const grant = this.#body(body);
    if (!grant) return;
    this.options.transfers.cancel(body, grant.owner);
    this.#bodies.delete(body.transferId);
  }

  retire(identity: NodeOperationIdentity): void {
    if (this.#closed) return;
    const operationId = this.#operationId(identity);
    const operation = this.#operations.get(operationId);
    if (!operation) return;
    this.#operations.delete(operationId);
    this.#retire(operation);
  }

  prune(): void {
    if (this.#closed) throw unavailable();
    for (const [transferId, body] of this.#bodies) if (this.options.transfers.status(body.identity) === null) this.#bodies.delete(transferId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    for (const operation of this.#operations.values()) if (operation) this.#retire(operation);
    this.#operations.clear();
    this.#bodies.clear();
  }

  #retire(operation: OperationGrant): void {
    operation.detach();
    operation.cancellation.abort(unavailable());
    for (const [id, body] of this.#bodies) if (body.operation === operation) this.#bodies.delete(id);
  }

  #require(identity: NodeOperationIdentity, kind: BodyKind, controlId: string | null): { operation: OperationGrant; bodySignal: AbortSignal } {
    const operationId = this.#operationId(identity);
    const operation = this.#operations.get(operationId);
    if (!operation || kind !== 'execution' && kind !== 'goal' && kind !== 'steer') throw unavailable();
    if (kind === 'steer' ? !isExecutionIdentity(controlId) : controlId !== null) throw unavailable();
    const bodySignal = operation.bodySignal(kind, controlId);
    operation.cancellation.signal.throwIfAborted();
    if (this.#closed || this.#operations.get(operationId) !== operation) throw unavailable();
    return { operation, bodySignal };
  }

  #operationId(value: NodeOperationIdentity): string {
    const identity = parseNodeOperationIdentity(value);
    if (this.#closed || !identity || !sameNodeSession(identity, this.#session)) throw unavailable();
    return identity.operationId;
  }

  #body(value: NodeBulkIdentity): BodyGrant | null {
    const identity = parseNodeBulkIdentity(value);
    if (this.#closed || !identity || !sameNodeSession(identity, this.#session)) throw unavailable();
    return this.#bodies.get(identity.transferId) ?? null;
  }
}

function unavailable(): NodeBulkError { return new NodeBulkError('NODE_BULK_UNAVAILABLE', 'Execution body grant is unavailable'); }
