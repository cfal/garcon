import { describe, expect, it, mock } from 'bun:test';
import createShareRoutes from '../shares.ts';
import { DomainError } from '../../lib/domain-error.ts';
import { LedgerFencedError } from '../../ledger/errors.ts';
import { TranscriptViewReader } from '../../ledger/view-reader.ts';

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
        content:
          'Yes. The thread discusses making the shared page readable without JavaScript.',
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

function createCapture(overrides = {}) {
  return {
    messages: [
      {
        type: 'user-message',
        timestamp: '2025-01-02T03:04:05.000Z',
        content: 'durable prompt',
      },
    ],
    transcriptViewId: 'view-1',
    lastOrdinal: 1,
    ...overrides,
  };
}

function createRoutes(snapshot = createSnapshot(), appTitle = null, overrides = {}) {
  const shareStore = {
    getShare: mock((token) =>
      token === snapshot.shareToken ? snapshot : null,
    ),
    getShareByChatId: mock(() => null),
    createShare: mock(() => Promise.resolve(snapshot)),
    updateShare: mock(() => Promise.resolve(snapshot)),
    revokeShareByChatId: mock(() => Promise.resolve(true)),
    init: mock(() => Promise.resolve(undefined)),
    ...overrides.shareStore,
  };
  const transcripts = {
    renderingSnapshot: mock(() => Promise.resolve(createCapture())),
    ...overrides.transcripts,
  };
  const routes = createShareRoutes(
    shareStore,
    { getChat: mock(() => overrides.session ?? null) },
    {
      getChatName: mock(() => null),
      getUiSettings: mock(() =>
        appTitle ? { appIdentity: { title: appTitle } } : {},
      ),
      getRemoteSettingsVersion: mock(() => (appTitle ? 3 : 0)),
    },
    { getChatMetadata: mock(() => null) },
    transcripts,
  );
  return { routes, shareStore, transcripts };
}

describe('share creation route', () => {
  it('[TLV5-L01.03-CORE-UNIT-01] creates the share from one pinned durable snapshot and records its origin', async () => {
    const created = [];
    const { routes, transcripts } = createRoutes(createSnapshot(), null, {
      session: { agentId: 'codex', model: 'gpt-5', projectPath: '/workspace/garcon' },
      shareStore: {
        createShare: mock((chatId, partial) => {
          created.push(partial);
          return Promise.resolve({ ...partial, shareToken: 'new-token' });
        }),
      },
    });

    const response = await routes['/api/v1/chats/share'].POST(
      new Request('http://localhost/api/v1/chats/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: '123' }),
      }),
      new URL('http://localhost/api/v1/chats/share'),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      shareToken: 'new-token',
      shareUrl: '/shared/new-token',
    });
    expect(transcripts.renderingSnapshot).toHaveBeenCalledWith('123');
    expect(created).toHaveLength(1);
    expect(created[0].messages.map((message) => message.content)).toEqual(['durable prompt']);
    expect(created[0].origin).toEqual({
      transcriptViewId: 'view-1',
      lastOrdinal: 1,
    });
  });

  it('maps a still-racing capture to its domain status instead of 500', async () => {
    const { routes } = createRoutes(createSnapshot(), null, {
      session: { agentId: 'codex', model: 'gpt-5', projectPath: '/workspace/garcon' },
      transcripts: {
        renderingSnapshot: mock(() => Promise.reject(
          new DomainError('SOURCE_REVISION_CHANGED', 'Chat ownership changed.', 409, true),
        )),
      },
    });

    const response = await routes['/api/v1/chats/share'].POST(
      new Request('http://localhost/api/v1/chats/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: '123' }),
      }),
      new URL('http://localhost/api/v1/chats/share'),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).success).toBe(false);
  });

  it('[TLV5-L11.01-SHARE-ROUTE-UNIT-01] returns a fixed error when snapshot capture is fenced', async () => {
    const sentinel = '/sentinel-root/chat-sentinel/ledger.sqlite';
    const reader = new TranscriptViewReader({}, {
      ensure: async () => {
        throw new LedgerFencedError('123', { cause: new Error(sentinel) });
      },
    });
    const { routes } = createRoutes(createSnapshot(), null, {
      session: { agentId: 'codex', model: 'gpt-5', projectPath: '/workspace/garcon' },
      transcripts: {
        renderingSnapshot: (chatId) => reader.renderingSnapshot(chatId),
      },
    });

    const response = await routes['/api/v1/chats/share'].POST(
      new Request('http://localhost/api/v1/chats/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: '123' }),
      }),
      new URL('http://localhost/api/v1/chats/share'),
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toEqual({ success: false, error: 'The transcript ledger is unavailable' });
    expect(JSON.stringify(body)).not.toContain(sentinel);
  });
});

describe('shared transcript routes', () => {
  it('renders plain text transcript at /shared/llm/:token', async () => {
    const { routes } = createRoutes();
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
    const { routes } = createRoutes();
    const response = await routes['/shared/llm/:token'].GET(
      new Request('http://localhost/shared/llm/missing-token'),
      new URL('http://localhost/shared/llm/missing-token'),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Share not found');
  });

  it('rejects malformed percent-encoded share tokens without throwing', async () => {
    const { routes } = createRoutes();
    const response = await routes['/shared/llm/:token'].GET(
      new Request('http://localhost/shared/llm/%'),
      new URL('http://localhost/shared/llm/%'),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Share token is required');
  });
});

describe('shared chat snapshot route', () => {
  it('returns the newest bounded page with an older-page cursor', async () => {
    const messages = Array.from({ length: 250 }, (_, index) => ({
      type: 'assistant-message',
      timestamp: '2025-01-02T03:05:05.000Z',
      content: `message-${index}`,
    }));
    const { routes } = createRoutes(createSnapshot({ messages }));
    const response = await routes['/api/v1/shared'].GET(
      new Request('http://localhost/api/v1/shared?token=share-token&limit=200'),
      new URL('http://localhost/api/v1/shared?token=share-token&limit=200'),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'no-cache, no-store, must-revalidate',
    );
    expect(body.snapshot.messages).toHaveLength(200);
    expect(body.snapshot.messages[0].content).toBe('message-50');
    expect(body.snapshot.messages[199].content).toBe('message-249');
    expect(body.page).toEqual({
      snapshotVersion: '2025-01-02T03:04:05.000Z',
      totalMessages: 250,
      start: 50,
      end: 250,
      nextBefore: 50,
    });
  });

  it('returns an exact older page without overlap', async () => {
    const messages = Array.from({ length: 250 }, (_, index) => ({
      type: 'assistant-message',
      timestamp: '2025-01-02T03:05:05.000Z',
      content: `message-${index}`,
    }));
    const { routes } = createRoutes(createSnapshot({ messages }));
    const response = await routes['/api/v1/shared'].GET(
      new Request(
        'http://localhost/api/v1/shared?token=share-token&limit=200&before=50&version=2025-01-02T03%3A04%3A05.000Z',
      ),
      new URL(
        'http://localhost/api/v1/shared?token=share-token&limit=200&before=50&version=2025-01-02T03%3A04%3A05.000Z',
      ),
    );
    const body = await response.json();

    expect(body.snapshot.messages).toHaveLength(50);
    expect(body.snapshot.messages[0].content).toBe('message-0');
    expect(body.snapshot.messages[49].content).toBe('message-49');
    expect(body.page).toEqual({
      snapshotVersion: '2025-01-02T03:04:05.000Z',
      totalMessages: 250,
      start: 0,
      end: 50,
      nextBefore: null,
    });
  });

  it('resets to the newest page when a cursor targets an older snapshot version', async () => {
    const snapshot = createSnapshot({
      messages: Array.from({ length: 250 }, (_, index) => ({
        type: 'assistant-message',
        timestamp: '2025-01-02T03:05:05.000Z',
        content: `message-${index}`,
      })),
    });
    const { routes } = createRoutes(snapshot);

    const firstResponse = await routes['/api/v1/shared'].GET(
      new Request('http://localhost/api/v1/shared?token=share-token&limit=200'),
      new URL('http://localhost/api/v1/shared?token=share-token&limit=200'),
    );
    const firstBody = await firstResponse.json();
    expect(firstBody.page.nextBefore).toBe(50);

    snapshot.sharedAt = '2025-01-02T04:04:05.000Z';
    snapshot.messages = Array.from({ length: 270 }, (_, index) => ({
      type: 'assistant-message',
      timestamp: '2025-01-02T03:05:05.000Z',
      content: `message-${index}`,
    }));

    const staleResponse = await routes['/api/v1/shared'].GET(
      new Request(
        `http://localhost/api/v1/shared?token=share-token&limit=200&before=${firstBody.page.nextBefore}&version=${encodeURIComponent(firstBody.page.snapshotVersion)}`,
      ),
      new URL(
        `http://localhost/api/v1/shared?token=share-token&limit=200&before=${firstBody.page.nextBefore}&version=${encodeURIComponent(firstBody.page.snapshotVersion)}`,
      ),
    );
    const staleBody = await staleResponse.json();

    expect(staleBody.snapshot.messages).toHaveLength(200);
    expect(staleBody.snapshot.messages[0].content).toBe('message-70');
    expect(staleBody.snapshot.messages[199].content).toBe('message-269');
    expect(staleBody.page).toEqual({
      snapshotVersion: '2025-01-02T04:04:05.000Z',
      totalMessages: 270,
      start: 70,
      end: 270,
      nextBefore: 70,
      reset: true,
    });
  });

  it('preserves the complete snapshot when pagination is not requested', async () => {
    const messages = Array.from({ length: 250 }, (_, index) => ({
      type: 'assistant-message',
      timestamp: '2025-01-02T03:05:05.000Z',
      content: `message-${index}`,
    }));
    const { routes } = createRoutes(createSnapshot({ messages }));
    const response = await routes['/api/v1/shared'].GET(
      new Request('http://localhost/api/v1/shared?token=share-token'),
      new URL('http://localhost/api/v1/shared?token=share-token'),
    );
    const body = await response.json();

    expect(body.snapshot.messages).toHaveLength(250);
    expect(body.page).toEqual({
      snapshotVersion: '2025-01-02T03:04:05.000Z',
      totalMessages: 250,
      start: 0,
      end: 250,
      nextBefore: null,
    });
  });
});

describe('shared chat page route', () => {
  it('serves bounded HTML with metadata and machine-readable transcript links', async () => {
    const { routes } = createRoutes();
    const response = await routes['/shared/:token'].GET(
      new Request('http://localhost/shared/share-token', {
        headers: { Accept: 'text/html' },
      }),
      new URL('http://localhost/shared/share-token'),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain(
      '<meta property="og:title" content="Investigate flaky share rendering" />',
    );
    expect(body).toContain('<meta property="og:site_name" content="Garcon" />');
    expect(body).toContain(
      '<meta property="og:url" content="http://localhost/shared/share-token" />',
    );
    expect(body).toContain('rel="alternate" type="text/plain"');
    expect(body).toContain('href="/shared/llm/share-token"');
    expect(response.headers.get('link')).toBe(
      '</shared/llm/share-token>; rel="alternate"; type="text/plain"',
    );
    expect(response.headers.get('vary')).toBe('Accept');
    expect(body).toContain('Read the full plain-text transcript');
    expect(body).not.toContain('All tests passed.');
  });

  it('keeps canonical HTML size independent of transcript size', async () => {
    const largeContent = 'large transcript content '.repeat(100_000);
    const { routes } = createRoutes(
      createSnapshot({
        messages: [
          {
            type: 'assistant-message',
            timestamp: '2025-01-02T03:05:05.000Z',
            content: largeContent,
          },
        ],
      }),
    );
    const response = await routes['/shared/:token'].GET(
      new Request('http://localhost/shared/share-token', {
        headers: { Accept: 'text/html' },
      }),
      new URL('http://localhost/shared/share-token'),
    );
    const body = await response.text();

    expect(body.length).toBeLessThan(100_000);
    expect(body).not.toContain(largeContent.slice(0, 1_000));
  });

  it('serves plain text from the canonical URL when explicitly requested', async () => {
    const { routes } = createRoutes();
    const request = new Request('http://localhost/shared/share-token', {
      headers: { Accept: 'text/plain' },
    });
    const response = await routes['/shared/:token'].GET(
      request,
      new URL(request.url),
    );
    const body = await response.text();

    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('vary')).toBe('Accept');
    expect(body).toContain('All tests passed.');
  });

  it('negotiates weighted and generic Accept headers without serving rejected types', async () => {
    const { routes } = createRoutes();
    const cases = [
      { accept: undefined, status: 200, type: 'text/plain' },
      { accept: '*/*', status: 200, type: 'text/plain' },
      { accept: 'text/plain;q=0', status: 406, type: null },
      {
        accept: 'text/plain;q=1, text/html;q=0',
        status: 200,
        type: 'text/plain',
      },
      {
        accept: 'text/plain;q=0.5, text/html;q=0.9',
        status: 200,
        type: 'text/html',
      },
      { accept: 'text/html, */*;q=0.8', status: 200, type: 'text/html' },
    ];

    for (const testCase of cases) {
      const request = new Request('http://localhost/shared/share-token', {
        headers: testCase.accept ? { Accept: testCase.accept } : undefined,
      });
      const response = await routes['/shared/:token'].GET(
        request,
        new URL(request.url),
      );

      expect(response.status).toBe(testCase.status);
      if (testCase.type) {
        expect(response.headers.get('content-type')).toContain(testCase.type);
      }
      expect(response.headers.get('vary')).toBe('Accept');
    }
  });

  it('uses the remote app title in shared-page metadata', async () => {
    const { routes } = createRoutes(createSnapshot(), 'Garcon - Work');
    const response = await routes['/shared/:token'].GET(
      new Request('http://localhost/shared/share-token', {
        headers: { Accept: 'text/html' },
      }),
      new URL('http://localhost/shared/share-token'),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      '<title>Investigate flaky share rendering · Garcon - Work</title>',
    );
    expect(body).toContain(
      '<meta property="og:site_name" content="Garcon - Work" />',
    );
    expect(body).toContain(
      '<meta name="apple-mobile-web-app-title" content="Garcon - Work" />',
    );
  });

  it('HTML-escapes snapshot content to prevent markup injection', async () => {
    const snapshot = createSnapshot({
      title: 'Bug <img src=x onerror=alert(1)>',
    });
    const { routes } = createRoutes(snapshot);
    const response = await routes['/shared/:token'].GET(
      new Request('http://localhost/shared/share-token', {
        headers: { Accept: 'text/html' },
      }),
      new URL('http://localhost/shared/share-token'),
    );
    const body = await response.text();

    expect(body).not.toContain('<img src=x onerror=alert(1)>');
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('serves the not-found path without throwing when the token is unknown', async () => {
    const { routes } = createRoutes();
    const response = await routes['/shared/:token'].GET(
      new Request('http://localhost/shared/missing-token'),
      new URL('http://localhost/shared/missing-token'),
    );

    // Either the SPA shell (build present) or a 404 (build absent) is acceptable;
    // the key contract is that no transcript leaks for an unknown token.
    expect([200, 404]).toContain(response.status);
    const body = await response.text();
    expect(body).not.toContain('All tests passed.');
  });
});
