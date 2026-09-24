import { DomainError } from '../lib/domain-error.js';
import type { CliPool } from './cli-protocol.js';

export class CliAdmission {
  readonly #nodes = new Map<string, { short: number; long: number }>();
  readonly #total = { short: 0, long: 0 };

  acquire(nodeId: string, pool: CliPool): () => void {
    const counts = this.#nodes.get(nodeId) ?? { short: 0, long: 0 };
    if (counts[pool] >= (pool === 'short' ? 6 : 2) || this.#total[pool] >= (pool === 'short' ? 32 : 8)) {
      throw new DomainError('CLI_SERVICE_BUSY', 'CLI service is busy; try again after current requests finish', 503, true);
    }
    counts[pool]++;
    this.#total[pool]++;
    this.#nodes.set(nodeId, counts);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      counts[pool]--;
      this.#total[pool]--;
      if (counts.short === 0 && counts.long === 0) this.#nodes.delete(nodeId);
    };
  }
}
