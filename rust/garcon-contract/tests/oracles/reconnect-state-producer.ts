import { ReconnectStateMessage } from '../../../../common/ws-events.js';
import {
  emptyStoredChatExecutionControl,
  toClientChatExecutionControlState,
} from '../../../../server/controller/chat-execution/control-state.js';

const server = 'fixture-instance';
const at = '2001-09-09T01:46:40.000Z';
const state = emptyStoredChatExecutionControl(server);
state.entries.push({
  id: 'entry', content: 'Synthetic queued input', kind: 'turn', revision: 2,
  createdAt: at, updatedAt: at, status: 'queued', images: [],
});
console.log(JSON.stringify(new ReconnectStateMessage(
  { outcome: 'snapshot', chats: [] },
  [
    { chatId: '1000000000000001', outcome: 'snapshot', control: toClientChatExecutionControlState(state) },
    { chatId: '1000000000000002', outcome: 'not-found' },
    { chatId: '1000000000000003', outcome: 'unavailable' },
  ],
  server,
  'request',
)));
