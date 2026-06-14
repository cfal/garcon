import { describe, expect, it, mock } from 'bun:test';
import createShareRoutes from '../shares.ts';

function createSnapshot(overrides = {}) {
  return {
    shareToken: 'share-token',
    chatId: '123',
    title: 'Investigate flaky share rendering',
    agentId: 'codex',
    model: 'gpt-5',
    projectPath: '/workspace/garcon',
    sharedAt: '2025-01-02T03:04:05.000Z',
    messages: [
      {
        type: 'user-message',
        timestamp: '2025-01-02T03:04:05.000Z',
        content: 'Can you summarize this thread for a crawler?',
      },
      {
        type: 'assistant-message',
        timestamp: '2025-01-02T03:05:05.000Z',
        content: 'Yes. The thread discusses making the shared page readable without JavaScript.',
      },
      {
        type: 'bash-tool-use',
        timestamp: '2025-01-02T03:06:05.000Z',
        toolId: 'tool-1',
        command: 'bun run test',
      },
      {
        type: 'tool-result',
        timestamp: '2025-01-02T03:06:30.000Z',
        toolId: 'tool-1',
        content: { raw: 'All tests passed.' },
        isError: false,
      },
    ],
    ...overrides,
  };
}

function createRoutes(snapshot = createSnapshot()) {
  return createShareRoutes(
    {
      getShare: mock((token) => token === snapshot.shareToken ? snapshot : null),
      getShareByChatId: mock(() => null),
      createShare: mock(() => Promise.resolve(snapshot)),
      updateShare: mock(() => Promise.resolve(snapshot)),
      revokeShareByChatId: mock(() => Promise.resolve(true)),
      init: mock(() => Promise.resolve(undefined)),
    },
    { getChat: mock(() => null) },
    { getChatName: mock(() => null) },
    { getChatMetadata: mock(() => null) },
    { readPage: mock(() => Promise.resolve({ events: [], logId: 'log-1', lastAppendSeq: 0, pageOldestSeq: 0, hasMore: false })) },
  );
}

describe('shared transcript routes', () => {
  it('renders plain text transcript at /shared/llm/:token', async () => {
    const routes = createRoutes();
    const response = await routes['/shared/llm/:token'].GET(
      new Request('http://localhost/shared/llm/share-token'),
      new URL('http://localhost/shared/llm/share-token'),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toContain('Title: Investigate flaky share rendering');
    expect(body).toContain('[User] 2025-01-02T03:04:05.000Z');
    expect(body).toContain('[Tool Result] 2025-01-02T03:06:30.000Z');
    expect(body).toContain('All tests passed.');
  });

  it('returns 404 when the shared transcript does not exist', async () => {
    const routes = createRoutes();
    const response = await routes['/shared/llm/:token'].GET(
      new Request('http://localhost/shared/llm/missing-token'),
      new URL('http://localhost/shared/llm/missing-token'),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Share not found');
  });

  it('rejects malformed percent-encoded share tokens without throwing', async () => {
    const routes = createRoutes();
    const response = await routes['/shared/llm/:token'].GET(
      new Request('http://localhost/shared/llm/%'),
      new URL('http://localhost/shared/llm/%'),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Share token is required');
  });
});
