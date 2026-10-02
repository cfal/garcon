import type { SessionTransport } from './session-transport.js';
import type { WebSocketLink } from './websocket-link.js';
import { ExecutorRpc, ParkedRpcCalls } from './rpc.js';
import { BulkConnection, type BulkConnectionOptions, type BulkConnectionStatus, type BulkAttemptFailure } from './bulk-connection.js';
import type { RpcReplyJournal } from './rpc-journal.js';
import type { RpcAdmissionBudgets } from './rpc-admission.js';
import type { RpcLane } from './rpc-lane.js';
import { AgentCallError } from '@garcon/server-agent-interface';
import { BULK_ACQUIRE_TIMEOUT_MS } from './limits.js';

export interface RpcConnectionOptions {
  readonly admission: RpcAdmissionBudgets;
  readonly parked?: Readonly<Record<RpcLane, ParkedRpcCalls>>;
  readonly journal?: RpcReplyJournal;
  readonly bulkTiming?: Pick<BulkConnectionOptions, 'setupTimeoutMs' | 'redialDelaysMs' | 'stableSessionMs'>;
  readonly bulkFailed?: (failure: BulkAttemptFailure & {
    calls: ReturnType<RpcAdmissionBudgets['snapshot']>;
  }) => void;
}

// A generation owns endpoints, never native processes or retained call budgets.
export class ExecutorRpcConnection {
  readonly primary: ExecutorRpc;
  readonly bulk: BulkConnection;
  readonly #endpoints = new Set<(rpc: ExecutorRpc) => void>();
  readonly #changes = new Set<(status: BulkConnectionStatus) => void>();
  #latestBulk: ExecutorRpc | null = null;
  #status: BulkConnectionStatus = { phase: 'offline', sessionId: null, error: null, retries: 0 };

  constructor(link: WebSocketLink, transport: SessionTransport, private readonly options: RpcConnectionOptions) {
    this.primary = new ExecutorRpc(transport, {
      admission: options.admission,
      journal: options.journal,
      parked: options.parked?.primary,
    });
    this.bulk = new BulkConnection(link, this.primary, {
      ...options.bulkTiming,
      failed: (failure) => options.bulkFailed?.({ ...failure, calls: options.admission.snapshot() }),
      install: (session) => {
        const rpc = new ExecutorRpc(session, {
          admission: options.admission,
          journal: options.journal,
          parked: options.parked?.bulk,
          recovering: true,
        });
        this.#latestBulk = rpc;
        session.onFailure(() => {
          if (this.#latestBulk === rpc) this.#latestBulk = null;
        });
        for (const listener of this.#endpoints) listener(rpc);
        return rpc;
      },
      changed: (status) => {
        this.#status = status;
        for (const listener of this.#changes) listener(status);
      },
    });
    transport.onFailure(() => {
      this.#endpoints.clear();
      this.#changes.clear();
    });
  }

  get status(): BulkConnectionStatus { return this.#status; }
  get diagnostics() {
    return {
      bulkPhase: this.#status.phase,
      bulkRetries: this.#status.retries,
      calls: this.options.admission.snapshot(),
    };
  }

  async acquire(
    lane: RpcLane,
    options: { signal: AbortSignal; timeoutMs: number | null },
  ): Promise<{ rpc: ExecutorRpc; timeoutMs: number | null }> {
    if (options.signal.aborted || !this.primary.active) {
      throw new AgentCallError('not-dispatched', 'The captured executor connection is unavailable');
    }
    const rpc = lane === 'primary' ? this.primary : this.bulk.current;
    if (rpc?.active) return { rpc, timeoutMs: options.timeoutMs };
    const started = performance.now();
    const reserve = options.timeoutMs === null ? 0 : Math.min(1_000, Math.floor(options.timeoutMs / 2));
    const waitMs = options.timeoutMs === null
      ? BULK_ACQUIRE_TIMEOUT_MS
      : Math.min(BULK_ACQUIRE_TIMEOUT_MS, options.timeoutMs - reserve);
    const release = this.options.admission.outgoing.acquire(lane);
    try {
      const endpoint = await this.bulk.wait({ signal: options.signal, timeoutMs: waitMs });
      const remainingTimeoutMs = options.timeoutMs === null
        ? null
        : Math.max(reserve, Math.ceil(options.timeoutMs - (performance.now() - started)));
      return { rpc: endpoint, timeoutMs: remainingTimeoutMs };
    } finally {
      release();
    }
  }

  owns(rpc: ExecutorRpc): boolean {
    return this.primary.transport.connected && rpc.transport.connected
      && (rpc === this.primary || rpc === this.#latestBulk);
  }

  onEndpoint(listener: (rpc: ExecutorRpc) => void): () => void {
    this.#endpoints.add(listener);
    listener(this.primary);
    if (this.#latestBulk) listener(this.#latestBulk);
    return () => { this.#endpoints.delete(listener); };
  }

  onBulkChanged(listener: (status: BulkConnectionStatus) => void): () => void {
    this.#changes.add(listener);
    return () => { this.#changes.delete(listener); };
  }

  activate(): void {
    this.primary.activate();
    this.bulk.start();
  }
}
