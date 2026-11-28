import { ChatExecutionControlUpdatedMessage } from '../../../../common/ws-events.ts';
import { createQueueEntry } from '../../../../server/controller/chat-execution/chat-execution-control-transitions.ts';
import {
  emptyStoredChatExecutionControl,
  toClientChatExecutionControlState,
} from '../../../../server/controller/chat-execution/control-state.ts';

const { next } = createQueueEntry(
  emptyStoredChatExecutionControl('fixture-instance'),
  { content: 'Synthetic queued input', images: [] },
  {
    now: '2001-09-09T01:46:40.000Z',
    newId: () => 'fixture-id',
    unsettledQueueReceiptKeys: () => new Set<string>(),
  },
);
console.log(JSON.stringify(new ChatExecutionControlUpdatedMessage(
  '1000000000000001',
  toClientChatExecutionControlState(next),
)));
