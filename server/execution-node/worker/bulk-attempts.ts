import { nodeBulkAttemptOrdinal } from '../../execution-nodes/transport/bulk-session-wire.js';
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

/** Fences consumed session-wide ordinals even when retirement overtakes installation. */
export class NodeWorkerBulkAttempts {
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  #active: ActiveAttempt | null = null;
  #consumedThrough = 0;

  constructor(private readonly authority: NodeWorkerAuthority) {
    const close = () => this.close();
    this.#detach = () => authority.signal.removeEventListener('abort', close);
    authority.signal.addEventListener('abort', close, { once: true });
    if (authority.signal.aborted) this.close();
  }

  attach(connectionId: number, bulkAttemptId: string): boolean {
    const ordinal = this.#validateIdentity(connectionId, bulkAttemptId);
    const connection = this.authority.connection(connectionId);
    const current = this.#active;
    if (current?.lease.connectionId === connectionId && current.lease.bulkAttemptId === bulkAttemptId) {
      current.lease.validate();
      return true;
    }
    if (ordinal <= this.#consumedThrough) return false;
    this.#consumedThrough = ordinal;
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
    const lease = this.#active?.lease;
    if (!lease || lease.connectionId !== connectionId || lease.bulkAttemptId !== bulkAttemptId) throw unavailable();
    lease.validate();
    return lease;
  }

  retire(connectionId: number, bulkAttemptId: string): void {
    const ordinal = this.#validateIdentity(connectionId, bulkAttemptId);
    this.authority.connection(connectionId);
    this.#consumedThrough = Math.max(this.#consumedThrough, ordinal);
    if (this.#active?.lease.connectionId === connectionId && this.#active.lease.bulkAttemptId === bulkAttemptId)
      this.#retireActive();
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#detach();
    this.#closing.abort(unavailable());
    this.#retireActive();
  }

  #retireActive(): void {
    const current = this.#active;
    this.#active = null;
    current?.cancellation.abort(unavailable());
  }

  #validateIdentity(connectionId: number, bulkAttemptId: string): number {
    this.#closing.signal.throwIfAborted();
    const ordinal = nodeBulkAttemptOrdinal(bulkAttemptId);
    if (!Number.isSafeInteger(connectionId) || connectionId < 1 || ordinal === null)
      throw new TypeError('Invalid bulk attempt identity');
    return ordinal;
  }
}

function unavailable(): NodeBulkError { return new NodeBulkError('NODE_BULK_UNAVAILABLE', 'Physical bulk attempt is unavailable'); }
