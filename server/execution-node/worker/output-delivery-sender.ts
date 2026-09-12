import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import type { NodeOutputDeliveryAttempt, NodeOutputDeliveryRecord } from './output-delivery.js';
import { serializeNodeWorkerOutputDelivery } from './output-delivery-protocol.js';
import { iterateNodeWorkerOutput } from './output-protocol.js';
import type { NodeWorkerWriter } from './writer.js';

export interface NodeWorkerOutputDeliverySenderOptions {
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly signal: AbortSignal;
  validate(): void;
}

/** Chunks one delivery record under both its logical stream and its captured physical attempt. */
export class NodeWorkerOutputDeliverySender {
  readonly #session: NodeSessionIdentity;

  constructor(private readonly writer: Pick<NodeWorkerWriter, 'submit'>, private readonly options: NodeWorkerOutputDeliverySenderOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session || !Number.isSafeInteger(options.connectionId) || options.connectionId < 1) throw new TypeError('Invalid output delivery connection');
    this.#session = Object.freeze(session);
    this.options = Object.freeze({ ...options });
  }

  async send(record: NodeOutputDeliveryRecord, attempt: NodeOutputDeliveryAttempt): Promise<void> {
    // Superseded synchronous recovery attempts allocate no record copy.
    await Promise.resolve();
    const completed = new AbortController();
    const signal = AbortSignal.any([this.options.signal, record.signal, attempt.signal, completed.signal]);
    const validate = () => {
      signal.throwIfAborted(); this.options.validate(); signal.throwIfAborted();
      if (!sameNodeSession(record.stream, this.#session)) throw new TypeError('Invalid output delivery stream');
    };
    let bytes: Buffer | null = null;
    try {
      validate();
      bytes = Buffer.from(record.serialized);
      for (const payload of iterateNodeWorkerOutput(record.instanceId, record.stream, record.sequence, bytes)) {
        validate();
        const text = serializeNodeWorkerOutputDelivery({ type: 'node-worker-output-delivery', version: NODE_WIRE_VERSION,
          session: this.#session, connectionId: this.options.connectionId, generation: attempt.generation, payload });
        await this.writer.submit(text, 'data', { signal, validate }).drained;
      }
    } finally { bytes?.fill(0); completed.abort(); }
  }
}
