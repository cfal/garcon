import { describe, expect, it, mock } from 'bun:test';
import { createChatRowRoutes } from '../chat-rows.ts';

const CHAT_ID = '1787000000000000';

describe('chat row routes', () => {
  it('returns a non-cacheable lazy target without using a history reader', async () => {
    const target = mock(async (chatId) => ({
      success: true,
      chatId,
      transcriptViewId: 'view-1',
    }));
    const routes = createChatRowRoutes({ target, add: async () => undefined });
    const url = new URL(`http://localhost/api/v1/chats/rows?chatId=${CHAT_ID}`);

    const response = await routes['/api/v1/chats/rows'].GET(new Request(url), url);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      success: true,
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
    });
    expect(target).toHaveBeenCalledWith(CHAT_ID, expect.any(AbortSignal));
  });

  it('validates target chat IDs and mutation bodies at the route boundary', async () => {
    const service = { target: mock(async () => undefined), add: mock(async () => undefined) };
    const routes = createChatRowRoutes(service);
    const missingUrl = new URL('http://localhost/api/v1/chats/rows');
    const invalidUrl = new URL('http://localhost/api/v1/chats/rows?chatId=bad');

    const missing = await routes['/api/v1/chats/rows'].GET(new Request(missingUrl), missingUrl);
    const invalid = await routes['/api/v1/chats/rows'].GET(new Request(invalidUrl), invalidUrl);
    const postUrl = new URL('http://localhost/api/v1/chats/rows');
    const malformed = await routes['/api/v1/chats/rows'].POST(new Request(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'alert', content: 'not supported' }),
    }), postUrl);

    for (const response of [missing, invalid, malformed]) {
      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toMatchObject({
        success: false,
        errorCode: 'VALIDATION_FAILED',
        retryable: false,
      });
    }
    expect(service.target).not.toHaveBeenCalled();
    expect(service.add).not.toHaveBeenCalled();
  });

  it('passes the exact typed mutation to the service and returns its durable result', async () => {
    const add = mock(async (input) => ({
      success: true,
      commandType: 'chat-row-add',
      ...input,
      ordinal: 4,
      status: 'appended',
      timestamp: '2026-08-18T00:00:00.000Z',
    }));
    const routes = createChatRowRoutes({ target: async () => undefined, add });
    const url = new URL('http://localhost/api/v1/chats/rows');
    const body = {
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
      type: 'notice',
      content: '  exact content\n',
    };

    const response = await routes['/api/v1/chats/rows'].POST(new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), url);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(add).toHaveBeenCalledWith(body, expect.any(AbortSignal));
    expect(await response.json()).toMatchObject({ status: 'appended', ordinal: 4 });
  });
});
