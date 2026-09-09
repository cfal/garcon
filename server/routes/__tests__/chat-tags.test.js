import { beforeEach, describe, expect, it, mock } from 'bun:test';

class MalformedJsonError extends Error {}
mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
  MalformedJsonError,
}));

import { parseJsonBody } from '../../lib/http-request.js';
import { ChatBoardDomainError } from '../../chat-boards/errors.ts';
import { createChatTagRoutes } from '../chat-tags.ts';

const BOARD_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';

async function call(handler, body, method = 'PATCH') {
  parseJsonBody.mockResolvedValueOnce(body);
  const request = new Request('http://localhost/test', { method });
  const response = await handler(request, new URL(request.url));
  return { response, body: await response.json() };
}

function service() {
  const result = { success: true, chatId: 'chat-1', tags: ['review'], addedTags: ['review'], removedTags: ['ready'] };
  return {
    replace: mock(async () => result),
    applyDelta: mock(async () => result),
    transition: mock(async () => result),
    recover: mock(async (chatId) => ({ success: true, chatId, tags: ['review'] })),
  };
}

describe('chat tag routes', () => {
  beforeEach(() => parseJsonBody.mockClear());

  it('normalizes replacement and delta input at the boundary', async () => {
    const tags = service();
    const routes = createChatTagRoutes(tags);
    await call(routes['/api/v1/chats/tags'].PATCH, {
      chatId: 'chat-1', expectedTags: ['Ready'], tags: ['In Review'],
    });
    await call(routes['/api/v1/chats/tags/delta'].PATCH, {
      chatId: 'chat-1', addTags: ['Needs Review'], removeTags: ['Ready'],
    });
    expect(tags.replace).toHaveBeenCalledWith({
      chatId: 'chat-1', expectedTags: ['ready'], tags: ['in-review'],
    });
    expect(tags.applyDelta).toHaveBeenCalledWith({
      chatId: 'chat-1', addTags: ['needs-review'], removeTags: ['ready'],
    });
  });

  it('forwards transition identities and selected ANY tags', async () => {
    const tags = service();
    const handler = createChatTagRoutes(tags)['/api/v1/chats/tag-transition'].POST;
    await call(handler, {
      chatId: 'chat-1',
      boardId: BOARD_ID,
      sourceColumnId: SOURCE_ID,
      targetColumnId: TARGET_ID,
      expectedCatalogRevision: 4,
      expectedTags: ['ready'],
      selectedTargetTags: ['Review'],
    }, 'POST');
    expect(tags.transition).toHaveBeenCalledWith({
      chatId: 'chat-1',
      boardId: BOARD_ID,
      sourceColumnId: SOURCE_ID,
      targetColumnId: TARGET_ID,
      expectedCatalogRevision: 4,
      expectedTags: ['ready'],
      selectedTargetTags: ['review'],
    });
  });

  it('rejects empty deltas and preserves unknown-durability recovery metadata', async () => {
    const tags = service();
    const routes = createChatTagRoutes(tags);
    const invalid = await call(routes['/api/v1/chats/tags/delta'].PATCH, {
      chatId: 'chat-1', addTags: [],
    });
    expect(invalid.response.status).toBe(400);
    expect(tags.applyDelta).not.toHaveBeenCalled();

    tags.replace.mockRejectedValueOnce(new ChatBoardDomainError(
      'CHAT_TAG_SAVE_UNKNOWN', 'Confirmation required', 503,
    ));
    const unknown = await call(routes['/api/v1/chats/tags'].PATCH, {
      chatId: 'chat-1', expectedTags: ['ready'], tags: ['review'],
    });
    expect(unknown.response.status).toBe(503);
    expect(unknown.body).toMatchObject({
      errorCode: 'CHAT_TAG_SAVE_UNKNOWN',
      retryable: false,
      recoveryRequired: true,
    });
  });
});
