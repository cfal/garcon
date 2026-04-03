import { describe, expect, it, mock } from 'bun:test';
import createShareRoutes from '../shares.ts';

function createSnapshot(overrides = {}) {
  return {
    shareToken: 'share-token',
    chatId: '123',
    title: 'Investigate flaky share rendering',
    provider: 'codex',
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
      revokeShareByChatId: mock(() => Promise.resolve(true)),
      init: mock(() => Promise.resolve(undefined)),
    },
    { getChat: mock(() => null) },
    { getChatName: mock(() => null) },
    { getChatMetadata: mock(() => null) },
    { ensureLoaded: mock(() => Promise.resolve(undefined)), getPaginatedMessages: mock(() => ({ messages: [] })) },
  );
}

describe('shared transcript routes', () => {
  it('renders transcript HTML at the public shared URL', async () => {
    const routes = createRoutes();
    const response = await routes['/shared/:token'].GET(
      new Request('http://localhost/shared/share-token'),
      new URL('http://localhost/shared/share-token'),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('Garcon Shared Thread');
    expect(body).toContain('Investigate flaky share rendering');
    expect(body).toContain('Can you summarize this thread for a crawler?');
    expect(body).toContain('bun run test');
    expect(body).toContain('/shared/share-token?format=text');
    expect(body).toContain('/shared-app/share-token');
    expect(body).toContain('/api/v1/shared?token=share-token');
  });

  it('renders a plain text variant for machine-friendly access', async () => {
    const routes = createRoutes();
    const response = await routes['/shared/:token'].GET(
      new Request('http://localhost/shared/share-token?format=text'),
      new URL('http://localhost/shared/share-token?format=text'),
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
    const response = await routes['/shared/:token'].GET(
      new Request('http://localhost/shared/missing-token'),
      new URL('http://localhost/shared/missing-token'),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Share not found');
  });

  it('rejects malformed percent-encoded share tokens without throwing', async () => {
    const routes = createRoutes();
    const response = await routes['/shared/:token'].GET(
      new Request('http://localhost/shared/%'),
      new URL('http://localhost/shared/%'),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Share token is required');
  });
});
