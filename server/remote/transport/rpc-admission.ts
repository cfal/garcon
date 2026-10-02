import { AgentCallError } from '@garcon/server-agent-interface';
import { BULK_RPC_CALL_LIMIT, RPC_CALL_LIMIT } from './limits.js';
import type { RpcLane } from './rpc-lane.js';

// Owned by the executor, not a replaceable socket or primary generation.
export class RpcAdmission {
  #total = 0;
  #bulk = 0;

  constructor(private readonly totalLimit = RPC_CALL_LIMIT, private readonly bulkLimit = BULK_RPC_CALL_LIMIT) {}

  get size(): number { return this.#total; }
  snapshot(): { total: number; primary: number; bulk: number } {
    return { total: this.#total, primary: this.#total - this.#bulk, bulk: this.#bulk };
  }

  acquire(lane: RpcLane): () => void {
    if (this.#total >= this.totalLimit || lane === 'bulk' && this.#bulk >= this.bulkLimit) {
      throw new AgentCallError('not-dispatched', 'The executor is handling too many requests. Try again shortly.');
    }
    this.#total++;
    if (lane === 'bulk') this.#bulk++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total--;
      if (lane === 'bulk') this.#bulk--;
    };
  }
}

export class RpcAdmissionBudgets {
  readonly incoming = new RpcAdmission();
  readonly outgoing = new RpcAdmission();

  snapshot() { return { incoming: this.incoming.snapshot(), outgoing: this.outgoing.snapshot() }; }
}
