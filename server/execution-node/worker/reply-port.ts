import type { NodeReplyPort } from '../../execution-nodes/transport/reply-port.js';
import type { NodeFrameWriter } from './writer.js';

/** Leaves admitted native replies and their byte accounting with the existing bounded frame writer. */
export function nodeWorkerReplies(writer: NodeFrameWriter): NodeReplyPort {
  return {
    enqueue(_requestId, text, authority) {
      const submission = writer.submit(text, 'data', authority, 'application');
      void submission.drained?.catch((error) => { if (!authority.signal.aborted) authority.failed(error); });
    },
    cancel() {},
    close() {},
  };
}
