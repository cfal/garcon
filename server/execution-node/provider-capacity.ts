import { NODE_WORKER_SERVICE_LIMITS } from './worker/limits.js';

export type NodeProviderRequestClass = 'status' | 'work';

/** Reserves status headroom and retains native slots until their owner observes actual settlement. */
export class NodeProviderCapacity {
  #pending = 0;
  #work = 0;

  constructor(
    private readonly maxRequests: number = NODE_WORKER_SERVICE_LIMITS.maxProviderRequests,
    private readonly reservedStatusRequests = Math.min(NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests, maxRequests - 1),
  ) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || !Number.isSafeInteger(reservedStatusRequests)
      || reservedStatusRequests < 0 || reservedStatusRequests >= maxRequests) throw new TypeError('Invalid provider capacity');
  }

  reserve(kind: NodeProviderRequestClass): (() => void) | null {
    if (this.#pending >= this.maxRequests || kind === 'work' && this.#work >= this.maxRequests - this.reservedStatusRequests) return null;
    this.#pending++;
    if (kind === 'work') this.#work++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#pending--;
      if (kind === 'work') this.#work--;
    };
  }
}
