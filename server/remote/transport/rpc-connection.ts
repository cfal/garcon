import type { SessionTransport } from './session-transport.js';
import type { WebSocketLink } from './websocket-link.js';
import { ExecutorRpc, ParkedRpcCalls } from './rpc.js';
import { BulkConnection, type BulkConnectionOptions, type BulkConnectionStatus } from './bulk-connection.js';
import type { RpcReplyJournal } from './rpc-journal.js';
import type { RpcAdmissionBudgets } from './rpc-admission.js';
import type { RpcLane } from './rpc-lane.js';

export interface RpcConnectionOptions {
  readonly admission: RpcAdmissionBudgets;
  readonly parked?: Readonly<Record<RpcLane, ParkedRpcCalls>>;
  readonly journal?: RpcReplyJournal;
  readonly bulkTiming?: Pick<BulkConnectionOptions, 'setupTimeoutMs' | 'redialDelaysMs' | 'stableSessionMs'>;
}

// A generation owns endpoints, never native processes or retained call budgets.
export class ExecutorRpcConnection {
  readonly primary: ExecutorRpc;
  readonly bulk: BulkConnection;
  readonly #endpoints = new Set<(rpc: ExecutorRpc) => void>();
  readonly #changes = new Set<(status: BulkConnectionStatus) => void>();
  #latestBulk: ExecutorRpc | null = null;
  #status: BulkConnectionStatus = { phase: 'offline', sessionId: null, error: null, retries: 0 };

  constructor(link: WebSocketLink, transport: SessionTransport, options: RpcConnectionOptions) {
    this.primary = new ExecutorRpc(transport, {
      admission: options.admission, journal: options.journal, parked: options.parked?.primary,
    });
    this.bulk = new BulkConnection(link, this.primary, {
      ...options.bulkTiming,
      install: (session) => {
        const rpc = new ExecutorRpc(session, {
          admission: options.admission, journal: options.journal, parked: options.parked?.bulk, recovering: true,
        });
        this.#latestBulk = rpc;
        session.onFailure(() => { if (this.#latestBulk === rpc) this.#latestBulk = null; });
        for (const listener of this.#endpoints) listener(rpc);
        return rpc;
      },
      changed: (status) => {
        this.#status = status;
        for (const listener of this.#changes) listener(status);
      },
    });
    transport.onFailure(() => { this.#endpoints.clear(); this.#changes.clear(); });
  }

  get status(): BulkConnectionStatus { return this.#status; }

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

  activate(): void { this.primary.activate(); this.bulk.start(); }

  dispose(): void {
    this.bulk.dispose();
    this.primary.transport.close();
  }
}
