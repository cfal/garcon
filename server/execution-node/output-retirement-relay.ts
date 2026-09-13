import { NodeOutputRetirements, type NodeOutputRetirementsOptions } from './output-retirements.js';
import type { NodeWorkerOutputRetirement } from './worker/output-retirement.js';
import type { NodeWorkerPeer } from './worker/peer.js';
import { NodeWorkerRetirementRelay } from './worker/retirement-relay.js';
import { confirmNodeOutputRetirement } from './worker/output-retirement-client.js';
import type { NodeWorkerServiceClient } from './worker/service-channel.js';

export interface NodeOutputRetirementRelayOptions extends NodeOutputRetirementsOptions {
  readonly peer: Pick<NodeWorkerPeer, 'forward' | 'waitForRelease'> & {
    service(connectionId: number): Pick<NodeWorkerServiceClient, 'call'>;
  };
  failed(error: unknown): void;
}

/** Keeps controller retirement delivery on the captured worker's logical lifetime across physical replacements. */
export class NodeOutputRetirementRelay {
  readonly #retirements: NodeOutputRetirements;
  readonly #relay: NodeWorkerRetirementRelay;
  readonly #detach: () => void;
  readonly #peer: NodeOutputRetirementRelayOptions['peer'];

  constructor(options: NodeOutputRetirementRelayOptions) {
    const { peer } = options;
    this.#peer = peer;
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

  async confirm(connectionId: number, signal: AbortSignal): Promise<void> {
    await this.#relay.flush();
    await this.#retirements.replay((frame, active) =>
      confirmNodeOutputRetirement(this.#peer.service(connectionId), frame, active), signal);
  }

  close(): void { this.#detach(); this.#relay.close(); this.#retirements.close(); }
}
