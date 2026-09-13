import { isExecutionIdentity } from '../../../common/execution-location.js';
import { NodeBulkError } from '../../execution-nodes/transport/bulk-transfers.js';
import type { NodeWorkerAuthority } from './authority.js';

export interface NodeWorkerBulkAttempt {
  readonly connectionId: number;
  readonly bulkAttemptId: string;
  readonly signal: AbortSignal;
  validate(): void;
}

interface ActiveAttempt {
  readonly lease: NodeWorkerBulkAttempt;
  readonly cancellation: AbortController;
}

/** Keeps retired physical identities consumed even when retirement overtakes their installation. */
export class NodeWorkerBulkAttempts {
  readonly #consumed = new Set<string>();
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  #active: ActiveAttempt | null = null;
  #exhausted = false;

  constructor(private readonly authority: NodeWorkerAuthority, private readonly maxIdentities = 4096) {
    if (!Number.isSafeInteger(maxIdentities) || maxIdentities < 1) throw new TypeError('Invalid bulk attempt limit');
    const close = () => this.close();
    this.#detach = () => authority.signal.removeEventListener('abort', close);
    authority.signal.addEventListener('abort', close, { once: true });
    if (authority.signal.aborted) this.close();
  }

  attach(connectionId: number, bulkAttemptId: string): boolean {
    this.#validateIdentity(connectionId, bulkAttemptId);
    const connection = this.authority.connection(connectionId);
    const current = this.#active;
    if (current?.lease.connectionId === connectionId && current.lease.bulkAttemptId === bulkAttemptId) {
      current.lease.validate();
      return true;
    }
    if (this.#consumed.has(bulkAttemptId)) return false;
    if (!this.#consume(bulkAttemptId)) return false;
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, connection.signal, this.#closing.signal]);
    const lease: NodeWorkerBulkAttempt = Object.freeze({ connectionId, bulkAttemptId, signal,
      validate: () => {
        signal.throwIfAborted();
        this.authority.assertConnection(connection);
        if (this.#active?.lease !== lease) throw unavailable();
      } });
    this.#active = { lease, cancellation };
    current?.cancellation.abort(unavailable());
    return true;
  }

  capture(connectionId: number, bulkAttemptId: string): NodeWorkerBulkAttempt {
    this.#validateIdentity(connectionId, bulkAttemptId);
    if (this.#exhausted) throw new NodeBulkError('NODE_CAPACITY', 'Bulk attempt identities are exhausted');
    const lease = this.#active?.lease;
    if (!lease || lease.connectionId !== connectionId || lease.bulkAttemptId !== bulkAttemptId) throw unavailable();
    lease.validate();
    return lease;
  }

  retire(connectionId: number, bulkAttemptId: string): void {
    this.#validateIdentity(connectionId, bulkAttemptId);
    this.authority.connection(connectionId);
    this.#consume(bulkAttemptId);
    if (this.#active?.lease.connectionId === connectionId && this.#active.lease.bulkAttemptId === bulkAttemptId)
      this.#retireActive();
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#detach();
    this.#closing.abort(unavailable());
    this.#retireActive();
  }

  #consume(bulkAttemptId: string): boolean {
    if (this.#exhausted) return false;
    if (this.#consumed.has(bulkAttemptId)) return true;
    if (this.#consumed.size >= this.maxIdentities) {
      this.#exhausted = true;
      this.#retireActive();
      return false;
    }
    this.#consumed.add(bulkAttemptId);
    return true;
  }

  #retireActive(): void {
    const current = this.#active;
    this.#active = null;
    current?.cancellation.abort(unavailable());
  }

  #validateIdentity(connectionId: number, bulkAttemptId: string): void {
    this.#closing.signal.throwIfAborted();
    if (!Number.isSafeInteger(connectionId) || connectionId < 1 || !isExecutionIdentity(bulkAttemptId))
      throw new TypeError('Invalid bulk attempt identity');
  }
}

function unavailable(): NodeBulkError { return new NodeBulkError('NODE_BULK_UNAVAILABLE', 'Physical bulk attempt is unavailable'); }
