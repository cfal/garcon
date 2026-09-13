import { sameNodeSession } from '../../../common/node-operation.js';
import type { NodeWorkerAuthority } from './authority.js';
import { NodeWorkerTransportError } from './framing.js';
import { serializeNodeWorkerChild, type NodeWorkerContainmentRequest } from './protocol.js';
import type { NodeWorkerWriter } from './writer.js';

/** Reports one whole-session containment request before retiring this worker's authority. */
export class NodeWorkerContainmentRelay {
  #requested = false;

  constructor(
    private readonly authority: NodeWorkerAuthority,
    private readonly writer: Pick<NodeWorkerWriter, 'submit'>,
  ) {}

  get requested(): boolean { return this.#requested; }

  request(request: NodeWorkerContainmentRequest): void {
    if (!sameNodeSession(request.session, this.authority.session)) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    if (this.#requested) return;
    this.#requested = true;
    this.authority.beginContainment();
    void this.#forward(request);
  }

  async #forward(request: NodeWorkerContainmentRequest): Promise<void> {
    try {
      const submission = this.writer.submit(serializeNodeWorkerChild(request), 'control', {
        signal: this.authority.signal,
        validate: () => { this.authority.poll(); this.authority.signal.throwIfAborted(); },
      }, 'lifecycle');
      await submission.drained;
    } catch { /* Worker exit still requests supervised cleanup if the reason cannot be delivered. */ }
    finally { this.authority.retire(); }
  }
}
