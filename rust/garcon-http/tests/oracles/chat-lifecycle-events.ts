import {
  ChatActivityUpdatedMessage,
  ChatProcessingUpdatedMessage,
  ChatSessionStoppedMessage,
} from '../../../../common/ws-events.ts';

const chatId = '1000000000000001';
console.log(JSON.stringify([
  new ChatSessionStoppedMessage(chatId, 'interrupt-requested', 'stop'),
  new ChatProcessingUpdatedMessage(chatId, 'stopping'),
  new ChatActivityUpdatedMessage(chatId, 'working'),
  new ChatProcessingUpdatedMessage(chatId, null),
  new ChatActivityUpdatedMessage(chatId, null),
  new ChatSessionStoppedMessage(chatId, 'already-idle', 'stop'),
]));
