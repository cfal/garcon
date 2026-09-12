import { NodeWorkerTransportError } from '../../execution-node/worker/framing.js';
import type { NodeFrameAdmission, NodeFrameSubmission, NodeFrameWriter, NodeWorkerFramePriority, NodeWorkerWriteAuthority } from '../../execution-node/worker/writer.js';
import type { NodeSocketWriter } from './socket-writer.js';

/** Admits synchronously; the socket owns its native backlog without per-frame drain promises. */
export class NodeSessionSocketWriter implements NodeFrameWriter {
  constructor(private readonly writer: Pick<NodeSocketWriter, 'send' | 'sendApplication' | 'sendData'>,
    private readonly signal: AbortSignal) {}

  submit(text: string, _priority: NodeWorkerFramePriority, authority: NodeWorkerWriteAuthority, admission: NodeFrameAdmission): NodeFrameSubmission {
    this.signal.throwIfAborted(); authority.signal.throwIfAborted();
    authority.validate();
    this.signal.throwIfAborted(); authority.signal.throwIfAborted();
    const accepted = admission === 'data' ? this.writer.sendData(text)
      : admission === 'application' ? this.writer.sendApplication(text) : this.writer.send(text);
    if (!accepted) throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY');
    return { submitted: true, drained: null };
  }
}
