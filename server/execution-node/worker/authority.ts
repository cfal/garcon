import { parseNodeSessionIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { NodeAuthorityError, type NodeConnectionLease } from '../supervisor.js';

export interface NodeWorkerAuthorityOptions {
  readonly session: NodeSessionIdentity;
  readonly signal: AbortSignal;
  poll(): number;
}

/** Mirrors one session's ordered admission gate; the coordinator remains the sole controller lease owner. */
export class NodeWorkerAuthority {
  readonly session: NodeSessionIdentity;
  readonly #controller = new AbortController();
  readonly #detach: () => void;
  #lastConnection = 0;
  #connection: { readonly lease: NodeConnectionLease; readonly controller: AbortController; admitting: boolean } | null = null;

  constructor(private readonly options: NodeWorkerAuthorityOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session) throw new TypeError('Invalid worker authority session');
    this.session = Object.freeze(session);
    const retire = () => this.retire();
    options.signal.addEventListener('abort', retire, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', retire);
    if (options.signal.aborted) this.retire();
  }

  get signal(): AbortSignal { return this.#controller.signal; }

  attach(connectionId: number): NodeConnectionLease {
    this.poll();
    this.#assertOpen();
    if (!Number.isSafeInteger(connectionId) || connectionId <= this.#lastConnection) throw expired();
    const previous = this.#connection;
    const controller = new AbortController();
    const lease: NodeConnectionLease = Object.freeze({ session: this.session, signal: controller.signal, authoritySignal: this.signal });
    this.#lastConnection = connectionId;
    this.#connection = { lease, controller, admitting: false };
    previous?.controller.abort(expired());
    return lease;
  }

  openAdmissions(connectionId: number): void {
    this.connection(connectionId);
    this.#connection!.admitting = true;
  }

  connection(connectionId: number): NodeConnectionLease {
    this.poll();
    this.#assertOpen();
    if (connectionId !== this.#lastConnection || !this.#connection) throw expired();
    return this.#connection.lease;
  }

  disconnect(connectionId: number): void {
    this.poll();
    if (connectionId !== this.#lastConnection || !this.#connection) return;
    const previous = this.#connection;
    this.#connection = null;
    previous.controller.abort(expired());
  }

  assertConnection(connection: NodeConnectionLease): void {
    this.poll();
    this.#assertOpen();
    if (this.#connection?.lease !== connection) throw expired();
  }

  assertAdmission(connection: NodeConnectionLease): void {
    this.assertConnection(connection);
    if (!this.#connection!.admitting) throw new NodeAuthorityError('NODE_UNAVAILABLE', 'Worker admissions are suspended');
  }

  poll(): number {
    if (this.signal.aborted) return NaN;
    try {
      const now = this.options.poll();
      if (!Number.isFinite(now) || now < 0) this.retire();
      return now;
    } catch { this.retire(); return NaN; }
  }

  retire(): void {
    if (this.signal.aborted) return;
    this.#detach();
    const previous = this.#connection;
    this.#connection = null;
    this.#controller.abort(expired());
    previous?.controller.abort(expired());
  }

  #assertOpen(): void { if (this.signal.aborted) throw expired(); }
}

function expired(): NodeAuthorityError { return new NodeAuthorityError('NODE_SESSION_EXPIRED', 'Worker execution authority is retired or replaced'); }
