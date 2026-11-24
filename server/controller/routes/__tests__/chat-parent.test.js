import { describe, expect, it, mock } from 'bun:test';
import { createChatParentRoutes } from '../chat-parent.ts';
import { DomainError } from '../../../common/domain-error.ts';

const chatId = '1783725900000200';
const parentChatId = '1783725900000201';
async function call(service, input) {
  const request = new Request('http://localhost/api/v1/chats/parent', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  return createChatParentRoutes(service)['/api/v1/chats/parent'].PUT(request, new URL(request.url));
}

describe('chat parent route', () => {
  it('passes only validated desired state to the service', async () => {
    const reply = { success: true, chatId, parentChatId: null, changed: true };
    const service = { set: mock(async () => reply) };
    expect(await (await call(service, { chatId, parentChatId: null })).json()).toEqual(reply);
    expect(service.set).toHaveBeenCalledWith({ chatId, parentChatId: null });
    for (const input of [{ chatId }, { chatId, parentChatId: 'title' }, { chatId, parentChatId, relation: 'fork' }]) {
      expect((await call(service, input)).status).toBe(400);
    }
    expect(service.set).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SESSION_NOT_FOUND', 404], ['PARENT_CHAT_NOT_FOUND', 404],
    ['CHAT_PARENT_CYCLE', 409],
    ['CHAT_PARENT_SAVE_FAILED', 503], ['CHAT_PARENT_SAVE_UNKNOWN', 503],
  ])('preserves %s errors', async (code, status) => {
    const service = { set: mock(async () => { throw new DomainError(code, 'Synthetic rejection', status); }) };
    const response = await call(service, { chatId, parentChatId });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ success: false, errorCode: code });
  });
});
