import { NodeWorkerTransportError } from '../../execution-node/worker/framing.js';
import type { NodeFrameSubmission, NodeFrameWriter, NodeWorkerFramePriority, NodeWorkerWriteAuthority } from '../../execution-node/worker/writer.js';
import type { NodeSocketWriter } from './socket-writer.js';

/** Admits synchronously; the socket owns its native backlog without per-frame drain promises. */
export class NodeSessionSocketWriter implements NodeFrameWriter {
  constructor(private readonly writer: Pick<NodeSocketWriter, 'send' | 'sendData'>,
    private readonly signal: AbortSignal) {}

  submit(text: string, priority: NodeWorkerFramePriority, authority: NodeWorkerWriteAuthority): NodeFrameSubmission {
    this.signal.throwIfAborted(); authority.signal.throwIfAborted();
    authority.validate();
    this.signal.throwIfAborted(); authority.signal.throwIfAborted();
    const accepted = priority === 'data' ? this.writer.sendData(text) : this.writer.send(text);
    if (!accepted) throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY');
    return { submitted: true, drained: null };
  }
}
