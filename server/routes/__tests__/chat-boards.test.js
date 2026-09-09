import { beforeEach, describe, expect, it, mock } from 'bun:test';

class MalformedJsonError extends Error {}
mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
  MalformedJsonError,
}));

import { parseJsonBody } from '../../lib/http-request.js';
import { ChatBoardDomainError } from '../../chat-boards/errors.ts';
import { createChatBoardRoutes } from '../chat-boards.ts';

const BOARD_ID = '11111111-1111-4111-8111-111111111111';
const COLUMN_ID = '22222222-2222-4222-8222-222222222222';
const empty = { revision: 0, boards: [] };

async function call(handler, body, method = 'POST') {
  parseJsonBody.mockResolvedValueOnce(body);
  const request = new Request('http://localhost/api/v1/chat-boards', { method });
  const response = await handler(request, new URL(request.url));
  return { response, body: await response.json() };
}

function service() {
  return {
    snapshot: mock(() => empty),
    create: mock(async () => ({ boardId: BOARD_ID, catalog: { revision: 1, boards: [] } })),
    update: mock(async () => ({ revision: 2, boards: [] })),
    remove: mock(async () => ({ revision: 3, boards: [] })),
    reorder: mock(async () => ({ revision: 4, boards: [] })),
  };
}

describe('chat board routes', () => {
  beforeEach(() => parseJsonBody.mockClear());

  it('returns the catalog and exact mutation envelopes', async () => {
    const chatBoards = service();
    const routes = createChatBoardRoutes(chatBoards);
    const get = await routes['/api/v1/chat-boards'].GET(
      new Request('http://localhost/api/v1/chat-boards'),
    );
    expect(await get.json()).toEqual(empty);

    const created = await call(routes['/api/v1/chat-boards'].POST, {
      expectedRevision: 0,
      name: 'Delivery',
    });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({ success: true, boardId: BOARD_ID, catalog: { revision: 1 } });
    expect(chatBoards.create).toHaveBeenCalledWith({ expectedRevision: 0, name: 'Delivery' });

    const board = {
      id: BOARD_ID,
      name: 'Delivery',
      columns: [{ id: COLUMN_ID, name: 'Ready', match: 'all', tags: ['ready'] }],
    };
    await call(routes['/api/v1/chat-boards'].PUT, { expectedRevision: 1, board }, 'PUT');
    expect(chatBoards.update).toHaveBeenCalledWith({ expectedRevision: 1, board });
  });

  it('rejects extra fields before invoking the service', async () => {
    const chatBoards = service();
    const routes = createChatBoardRoutes(chatBoards);
    const result = await call(routes['/api/v1/chat-boards'].POST, {
      expectedRevision: 0,
      name: 'Delivery',
      extra: true,
    });
    expect(result.response.status).toBe(400);
    expect(result.body.errorCode).toBe('CHAT_BOARD_VALIDATION_FAILED');
    expect(chatBoards.create).not.toHaveBeenCalled();
  });

  it('preserves typed conflicts and authoritative catalogs', async () => {
    const chatBoards = service();
    chatBoards.create.mockRejectedValueOnce(new ChatBoardDomainError(
      'CHAT_BOARD_REVISION_CONFLICT',
      'Changed elsewhere',
      409,
      true,
      { revision: 2, boards: [] },
    ));
    const result = await call(createChatBoardRoutes(chatBoards)['/api/v1/chat-boards'].POST, {
      expectedRevision: 0,
      name: 'Delivery',
    });
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({
      success: false,
      errorCode: 'CHAT_BOARD_REVISION_CONFLICT',
      retryable: true,
      catalog: { revision: 2 },
    });
  });
});
