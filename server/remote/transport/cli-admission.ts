import { DomainError } from '../../common/domain-error.js';
import type { CliPool } from './cli-protocol.js';
import type { RpcLane } from './rpc-lane.js';

export class CliAdmission {
  readonly #executors = new Map<string, { short: number; long: number; bulkShort: number }>();
  readonly #total = { short: 0, long: 0, bulkShort: 0 };

  acquire(executorId: string, pool: CliPool, lane: RpcLane): () => void {
    const counts = this.#executors.get(executorId) ?? { short: 0, long: 0, bulkShort: 0 };
    const bulkShort = pool === 'short' && lane === 'bulk';
    if (counts[pool] >= (pool === 'short' ? 6 : 2) || this.#total[pool] >= (pool === 'short' ? 32 : 8)
      || bulkShort && (counts.bulkShort >= 4 || this.#total.bulkShort >= 24)) {
      throw new DomainError('CLI_SERVICE_BUSY', 'CLI service is busy; try again after current requests finish', 503, true);
    }
    counts[pool]++;
    this.#total[pool]++;
    if (bulkShort) { counts.bulkShort++; this.#total.bulkShort++; }
    this.#executors.set(executorId, counts);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      counts[pool]--;
      this.#total[pool]--;
      if (bulkShort) { counts.bulkShort--; this.#total.bulkShort--; }
      if (counts.short === 0 && counts.long === 0) this.#executors.delete(executorId);
    };
  }
}
