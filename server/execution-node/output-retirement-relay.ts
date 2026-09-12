import { NodeOutputRetirements, type NodeOutputRetirementsOptions } from './output-retirements.js';
import type { NodeWorkerOutputRetirement } from './worker/output-retirement.js';
import type { NodeWorkerPeer } from './worker/peer.js';
import { NodeWorkerRetirementRelay } from './worker/retirement-relay.js';

export interface NodeOutputRetirementRelayOptions extends NodeOutputRetirementsOptions {
  readonly peer: Pick<NodeWorkerPeer, 'forward' | 'waitForRelease'>;
  failed(error: unknown): void;
}

/** Keeps controller retirement delivery on the captured worker's logical lifetime across physical replacements. */
export class NodeOutputRetirementRelay {
  readonly #retirements: NodeOutputRetirements;
  readonly #relay: NodeWorkerRetirementRelay;
  readonly #detach: () => void;

  constructor(options: NodeOutputRetirementRelayOptions) {
    const { peer } = options;
    this.#retirements = new NodeOutputRetirements(options);
    this.#relay = new NodeWorkerRetirementRelay({
      send: (frame, signal) => peer.forward(frame, signal).drained,
      waitForRelease: (signal) => peer.waitForRelease(signal),
      failed: options.failed,
    });
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  enqueue(frame: NodeWorkerOutputRetirement): void {
    this.#relay.enqueue(this.#retirements.record(frame));
  }

  flush(): Promise<void> { return this.#relay.flush(); }

  close(): void { this.#detach(); this.#relay.close(); this.#retirements.close(); }
}
