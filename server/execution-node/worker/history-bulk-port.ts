import { sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { isNodeBulkData, isNodeBulkReply, parseNodeBulkFrameText } from '../../execution-nodes/transport/bulk-channel-wire.js';
import { NodeBulkError } from '../../execution-nodes/transport/bulk-transfers.js';
import type { NodeHistoryBulkPort } from '../../execution-nodes/transport/provider-history-bulk-channel.js';
import { serializeNodeHistoryBulk, type NodeHistoryBulkFrame } from '../../execution-nodes/transport/provider-history-bulk-wire.js';
import type { NodeWorkerBulkAttempt } from './bulk-attempts.js';
import { NodeWorkerTransportError } from './framing.js';
import type { NodeWorkerWriter } from './writer.js';

export interface NodeWorkerHistoryBulkPortOptions {
  readonly session: NodeSessionIdentity;
  readonly instanceId: string;
  readonly signal: AbortSignal;
  capture(connectionId: number, bulkAttemptId: string): NodeWorkerBulkAttempt;
}

/** Sends reverse history before any inbound bulk frame; the shared writer owns bounded native retention. */
export class NodeWorkerHistoryBulkPort implements NodeHistoryBulkPort {
  constructor(private readonly writer: Pick<NodeWorkerWriter, 'submit'>, private readonly options: NodeWorkerHistoryBulkPortOptions) {}

  send(frame: NodeHistoryBulkFrame): boolean {
    try { this.#submit(frame, this.options.signal, () => {}); return true; }
    catch (error) {
      if (error instanceof NodeWorkerTransportError && error.code === 'NODE_WORKER_CAPACITY') return false;
      throw error;
    }
  }

  async sendWhenWritable(frame: NodeHistoryBulkFrame, signal: AbortSignal, validate: () => void): Promise<void> {
    try { await this.#submit(frame, signal, validate).drained; }
    catch (error) {
      if (error instanceof NodeWorkerTransportError && error.code === 'NODE_WORKER_CAPACITY')
        throw new NodeBulkError('NODE_CAPACITY', 'History worker writes are at capacity');
      throw error;
    }
  }

  #submit(frame: NodeHistoryBulkFrame, caller: AbortSignal, beforeSend: () => void) {
    const text = serializeNodeHistoryBulk(frame);
    const payload = parseNodeBulkFrameText(frame.payload)!;
    if (frame.instanceId !== this.options.instanceId || !sameNodeSession(frame.identity, this.options.session)
      || isNodeBulkReply(payload) || payload.type === 'node-bulk-chunk') throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    const attempt = this.options.capture(frame.connectionId, frame.bulkAttemptId);
    const signal = AbortSignal.any([caller, this.options.signal, attempt.signal]);
    const validate = () => { signal.throwIfAborted(); attempt.validate(); beforeSend(); };
    validate();
    const data = isNodeBulkData(payload);
    const submission = this.writer.submit(text, data ? 'data' : 'urgent', { signal, validate }, data ? 'data' : 'application');
    // A lost reply or frame is settled by the row's credit/completion deadline, without retiring this shared pipe.
    void submission.drained.catch(() => {});
    return submission;
  }
}
