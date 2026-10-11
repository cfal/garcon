import { expect, it, mock } from 'bun:test';
import { createChatClearRoutes } from '../chat-clear.ts';
import { DomainError } from '../../../common/domain-error.ts';

const target = { chatId: '1780000000000001', transcriptViewId: 'view-1', lastOrdinal: 4 };
const url = new URL('http://localhost/api/v1/chats/clear');
function send(service, body) {
  return createChatClearRoutes(service)[url.pathname].POST(new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), url);
}

it('validates before dispatch and passes the captured target and cancellation signal', async () => {
  const clear = mock(async request => ({ success: true, chatId: request.chatId, transcriptViewId: 'view-2' }));
  expect((await send({ clear }, { ...target, lastOrdinal: -1 })).status).toBe(400);
  expect(clear).not.toHaveBeenCalled();
  const response = await send({ clear }, target);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, chatId: target.chatId, transcriptViewId: 'view-2' });
  expect(clear).toHaveBeenCalledWith(target, expect.any(AbortSignal));
});

it('preserves typed conflict errors', async () => {
  const response = await send({ clear: async () => { throw new DomainError('CHAT_RUNNING', 'Busy', 409, true); } }, target);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ success: false, errorCode: 'CHAT_RUNNING', retryable: true });
});
