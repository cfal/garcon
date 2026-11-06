import { afterAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AssistantMessage,
  CommandOutputMessage,
  CommandResultMessage,
  UserMessage,
} from '../../../../common/chat-types.ts';
import createShareRoutes, {
  SHARED_CHAT_RATE_LIMIT_MAX_REQUESTS,
  SHARED_CHAT_RATE_LIMIT_WINDOW_MS,
} from '../shares.ts';
import { isNoAuthHandler, wrapRoutes } from '../../lib/http-route.ts';
import { ShareStore } from '../../chats/shares/store.ts';
import { inlineTranscriptRendering } from '../../chats/transcript-rendering/__tests__/inline-transcript-rendering.ts';
import { DomainError } from '../../../common/domain-error.ts';
import { renderSharedChatText } from '../../chats/shares/transcript.ts';
import { decodeStoredLedgerRow } from '../../ledger/codec.ts';
import { LedgerFencedError } from '../../ledger/errors.ts';
import { storedProviderRows, storedSnapshotReader } from '../../ledger/__tests__/stored-rows.ts';
import { TranscriptViewReader } from '../../ledger/view-reader.ts';
import { createRateLimiter } from '../../lib/rate-limit.ts';

const textDirectory = mkdtempSync(path.join(os.tmpdir(), 'garcon-share-routes-'));
afterAll(() => rmSync(textDirectory, { recursive: true, force: true }));

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
    rows: storedProviderRows([new UserMessage('2025-01-02T03:04:05.000Z', 'durable prompt')]),
    transcriptViewId: 'view-1',
    lastOrdinal: 1,
    ...overrides,
  };
}

// Serves the test's snapshot the way ShareStore does: messages as stored JSON lines and the
// plain text from a file, read from the snapshot object on each call so tests can replace it.
function snapshotStore(snapshot) {
  const matches = (token) => token === snapshot.shareToken;
  const header = () => {
    const { messages, ...fields } = snapshot;
    return { ...fields, messageCount: messages.length };
  };
  return {
    getHeader: mock(async (token) => (matches(token) ? header() : null)),
    getMessages: mock(async (token, select) => {
      if (!matches(token)) return null;
      const current = header();
      const range = select?.(current) ?? { start: 0, end: current.messageCount };
      return { header: current, messages: snapshot.messages.slice(range.start, range.end).map(message => JSON.stringify(message)) };
    }),
    getTextPath: mock(async (token) => {
      if (!matches(token)) return null;
      const textPath = path.join(textDirectory, `${token}-${Math.random()}.txt`);
      writeFileSync(textPath, renderSharedChatText(snapshot));
      return textPath;
    }),
    getEntryByChatId: mock(() => null),
    publish: mock(() => Promise.resolve(snapshot)),
    revokeShareByChatId: mock(() => Promise.resolve(true)),
    init: mock(() => Promise.resolve(undefined)),
  };
}

function createRoutes(snapshot = createSnapshot(), appTitle = null, overrides = {}) {
  const shareStore = {
    ...snapshotStore(snapshot),
    ...overrides.shareStore,
  };
  const capture = overrides.capture ?? mock(() => Promise.resolve(createCapture()));
  const transcripts = overrides.transcripts ?? storedSnapshotReader(capture);
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
    // Unrelated tests share one unaddressed client, so only rate-limit tests opt into a limiter.
    { sharedChatLimiter: 'sharedChatLimiter' in overrides ? overrides.sharedChatLimiter : { check: () => null } },
  );
  return { routes, shareStore, capture };
}

describe('share storage error boundaries', () => {
  it.each([
    ['POST', 'publish'],
    ['DELETE', 'revokeShareByChatId'],
  ])('codes unexpected %s failures without exposing internal details', async (method, operation) => {
    const { routes } = createRoutes(undefined, null, {
      session: { agentId: 'codex', model: 'test', projectPath: '/synthetic' },
      shareStore: { [operation]: () => { throw new Error('/private/synthetic-storage'); } },
    });
    const url = new URL('http://localhost/api/v1/chats/share?chatId=123');
    const response = await routes[url.pathname][method](new Request(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ chatId: '123' }) : undefined,
    }), url);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false, error: 'Internal server error', errorCode: 'INTERNAL_ERROR', retryable: true,
    });
  });

  it('codes a missing share on revocation', async () => {
    const { routes } = createRoutes(undefined, null, { shareStore: { revokeShareByChatId: async () => false } });
    const url = new URL('http://localhost/api/v1/chats/share?chatId=123');
    const response = await routes[url.pathname].DELETE(new Request(url, { method: 'DELETE' }), url);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false, error: 'Share not found', errorCode: 'VALIDATION_FAILED', retryable: false,
    });
  });

  it.each([
    ['/api/v1/chats/share', 'POST', '', 'publish', false],
    ['/api/v1/chats/share', 'DELETE', '?chatId=123', 'revokeShareByChatId', false],
    ['/api/v1/chats/share/status', 'GET', '?chatId=123', 'getEntryByChatId', false],
    ['/api/v1/shared', 'GET', '?token=share-token&limit=10', 'getMessages', true],
    ['/shared/:token', 'GET', '', 'getHeader', true],
    ['/shared/llm/:token', 'GET', '', 'getTextPath', true],
  ])('preserves unavailable status for %s %s', async (route, method, query, operation, publicRoute) => {
    const error = new DomainError('SHARE_STORAGE_UNAVAILABLE', 'Restart the controller before accessing shares.', 503);
    const { routes } = createRoutes(undefined, null, {
      session: { agentId: 'codex', model: 'test', projectPath: '/synthetic' },
      shareStore: { [operation]: () => { throw error; } },
    });
    const handler = routes[route][method];
    const url = new URL(`http://localhost${route.replace(':token', 'share-token')}${query}`);
    const response = await handler(new Request(url, {
      method,
      headers: { Accept: 'text/html', 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ chatId: '123' }) : undefined,
    }), url);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false, error: error.message, errorCode: 'SHARE_STORAGE_UNAVAILABLE', retryable: false,
    });
    expect(isNoAuthHandler(handler)).toBe(publicRoute);
    if (method === 'GET') expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
});

describe('share creation route', () => {
  it('reports snapshot overload without starting publication', async () => {
    const { routes, shareStore } = createRoutes(undefined, null, {
      session: { agentId: 'codex', model: 'test', projectPath: '/synthetic' },
      transcripts: { withStoredSnapshot: async () => { throw new DomainError('TRANSCRIPT_WORK_BUSY', 'Transcript capacity is full', 503, true); } },
    });
    const url = new URL('http://localhost/api/v1/chats/share');
    const response = await routes[url.pathname].POST(new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: '123' }),
    }), url);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ success: false, errorCode: 'TRANSCRIPT_WORK_BUSY', retryable: true });
    expect(shareStore.publish).not.toHaveBeenCalled();
  });

  it('[TLV5-L01.03-CORE-UNIT-01] creates the share from one pinned durable snapshot and records its origin', async () => {
    const created = [];
    const { routes, capture } = createRoutes(createSnapshot(), null, {
      session: { agentId: 'codex', model: 'gpt-5', projectPath: '/workspace/garcon' },
      shareStore: {
        publish: mock((chatId, publication, rows) => {
          created.push({ publication, rows });
          return Promise.resolve({ ...publication, shareToken: 'new-token' });
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
    expect(capture).toHaveBeenCalledWith('123');
    expect(created).toHaveLength(1);
    expect(created[0].rows.map((row) => decodeStoredLedgerRow(row).message.content)).toEqual(['durable prompt']);
    expect(created[0].publication.origin).toEqual({
      transcriptViewId: 'view-1',
      lastOrdinal: 1,
    });
  });

  it('maps a still-racing capture to its domain status instead of 500', async () => {
    const { routes } = createRoutes(createSnapshot(), null, {
      session: { agentId: 'codex', model: 'gpt-5', projectPath: '/workspace/garcon' },
      capture: mock(() => Promise.reject(
        new DomainError('SOURCE_REVISION_CHANGED', 'Chat ownership changed.', 409, true),
      )),
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
      transcripts: reader,
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
    expect(body).toEqual({
      success: false, error: 'The transcript ledger is unavailable', errorCode: 'TRANSCRIPT_UNAVAILABLE', retryable: false,
    });
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

describe('public share responses', () => {
  const PUBLIC_ROUTES = ['/api/v1/shared', '/shared/:token', '/shared/llm/:token'];
  const publicRequests = [
    ['/api/v1/shared', 'http://localhost/api/v1/shared?token=share-token', {}],
    ['/api/v1/shared', 'http://localhost/api/v1/shared?token=missing-token', {}],
    ['/shared/:token', 'http://localhost/shared/share-token', { Accept: 'text/html' }],
    ['/shared/:token', 'http://localhost/shared/share-token', {}],
    ['/shared/:token', 'http://localhost/shared/missing-token', { Accept: 'text/html' }],
    ['/shared/llm/:token', 'http://localhost/shared/llm/share-token', {}],
    ['/shared/llm/:token', 'http://localhost/shared/llm/missing-token', {}],
  ];

  function expectPublicHeaders(response) {
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  }

  it.each(publicRequests)('keeps %s (%s) out of search indexes and referrers', async (route, href, headers) => {
    const served = wrapRoutes(createRoutes().routes);
    expectPublicHeaders(await served[route].GET(new Request(href, { headers })));
  });

  it('adds the public headers to unexpected failures and shutdown responses', async () => {
    let shuttingDown = false;
    const failure = async () => { throw new Error('synthetic storage failure'); };
    const { routes } = createRoutes(createSnapshot(), null, {
      shareStore: { getHeader: failure, getMessages: failure, getTextPath: failure },
    });
    const served = wrapRoutes(routes, { isShuttingDown: () => shuttingDown });
    const request = (route) => served[route].GET(new Request(`http://localhost${route.replace(':token', 'share-token')}?token=share-token`, {
      headers: { Accept: 'text/html' },
    }));

    for (const route of PUBLIC_ROUTES) {
      const failed = await request(route);
      expect(failed.status).toBe(500);
      expectPublicHeaders(failed);
    }
    shuttingDown = true;
    for (const route of PUBLIC_ROUTES) {
      const stopping = await request(route);
      expect(stopping.status).toBe(503);
      expectPublicHeaders(stopping);
    }
    expect((await served['/api/v1/chats/share/status'].GET(new Request('http://localhost/api/v1/chats/share/status?chatId=123')))
      .headers.get('x-robots-tag')).toBeNull();
  });

  it('withholds execution context and the project path from every public representation', async () => {
    const sentinel = '/private/sentinel-project';
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'garcon-share-public-'));
    try {
      const store = new ShareStore(workspace, { rendering: inlineTranscriptRendering });
      await store.init();
      const at = '2025-01-02T03:04:05.000Z';
      const rows = storedProviderRows([
        new UserMessage(at, 'Run the build'),
        new CommandOutputMessage(at, 'command-1', 'stdout', 'plain', 'build passed', {
          executorId: 'local',
          projectPath: sentinel,
        }),
        new CommandResultMessage(at, 'command-1', {
          outcome: 'finished', exitCode: 0, signal: null, capture: 'complete',
          cwd: { kind: 'reported', path: `${sentinel}/packages` },
        }),
        new AssistantMessage(at, 'The build passed.'),
      ]);
      const routes = createShareRoutes(
        store,
        { getChat: mock(() => ({ agentId: 'shell', model: 'sh', projectPath: sentinel })) },
        { getChatName: mock(() => null), getUiSettings: mock(() => ({})), getRemoteSettingsVersion: mock(() => 0) },
        { getChatMetadata: mock(() => null) },
        storedSnapshotReader(async () => ({ rows, transcriptViewId: 'view-1', lastOrdinal: rows.length })),
      );
      const created = await (await routes['/api/v1/chats/share'].POST(new Request('http://localhost/api/v1/chats/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: '123' }),
      }), new URL('http://localhost/api/v1/chats/share'))).json();
      const token = created.shareToken;
      const read = async (route, href, headers = {}) => (
        await routes[route].GET(new Request(href, { headers }), new URL(href))
      ).text();

      const json = await read('/api/v1/shared', `http://localhost/api/v1/shared?token=${token}`);
      const bodies = [
        json,
        await read('/shared/llm/:token', `http://localhost/shared/llm/${token}`),
        await read('/shared/:token', `http://localhost/shared/${token}`, { Accept: 'text/plain' }),
        await read('/shared/:token', `http://localhost/shared/${token}`, { Accept: 'text/html' }),
      ];
      for (const body of bodies) expect(body).not.toContain(sentinel);
      const { snapshot } = JSON.parse(json);
      expect(Object.keys(snapshot).sort()).toEqual(['agentId', 'messages', 'model', 'shareToken', 'sharedAt', 'title']);
      expect(snapshot.messages.map((message) => message.type)).toEqual(
        ['user-message', 'command-output', 'command-result', 'assistant-message'],
      );
      expect(snapshot.messages[1]).toMatchObject({ content: 'build passed', context: null });
      expect(snapshot.messages[2].result.cwd).toEqual({ kind: 'withheld' });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('public share lookup', () => {
  const lookups = ['', '?token=', '?token=..%2F..%2Fetc%2Fpasswd', '?token=__proto__', '?token=has%20space%00',
    `?token=${'x'.repeat(4096)}`, '?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'];
  const serverFor = (address) => ({ requestIP: () => ({ address }) });
  const fetchShared = (routes, search = '', server, headers) => {
    const href = `http://localhost/api/v1/shared${search}`;
    return routes['/api/v1/shared'].GET(new Request(href, { headers }), new URL(href), server);
  };
  async function observable(response) {
    const headers = Object.fromEntries(response.headers);
    return { status: response.status, headers, body: await response.text() };
  }

  it('answers missing, malformed, and unknown tokens identically through the real store', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'garcon-share-lookup-'));
    try {
      const store = new ShareStore(workspace, { rendering: inlineTranscriptRendering });
      await store.init();
      const rows = storedProviderRows([new UserMessage('2025-01-02T03:04:05.000Z', 'synthetic prompt')]);
      const routes = createShareRoutes(
        store,
        { getChat: mock(() => ({ agentId: 'shell', model: 'sh', projectPath: '/synthetic' })) },
        { getChatName: mock(() => null), getUiSettings: mock(() => ({})), getRemoteSettingsVersion: mock(() => 0) },
        { getChatMetadata: mock(() => null) },
        storedSnapshotReader(async () => ({ rows, transcriptViewId: 'view-1', lastOrdinal: rows.length })),
        { sharedChatLimiter: { check: () => null } },
      );
      const created = await (await routes['/api/v1/chats/share'].POST(new Request('http://localhost/api/v1/chats/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: '123' }),
      }), new URL('http://localhost/api/v1/chats/share'))).json();

      const observed = await Promise.all(lookups.map(async (search) => observable(await fetchShared(routes, search))));
      for (const response of observed) expect(response).toEqual(observed[0]);
      expect(observed[0].status).toBe(404);
      expect(JSON.parse(observed[0].body)).toEqual({
        success: false, error: 'Share not found', errorCode: 'VALIDATION_FAILED', retryable: false,
      });
      expect((await fetchShared(routes, `?token=${created.shareToken}`)).status).toBe(200);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('consults the store for a missing token as for an unknown one', async () => {
    const { routes, shareStore } = createRoutes();
    await fetchShared(routes);
    await fetchShared(routes, '?token=missing-token');
    expect(shareStore.getMessages.mock.calls.map(([token]) => token)).toEqual(['', 'missing-token']);
  });

  it('serves the production limiter with 429 and Retry-After after the configured misses', async () => {
    const { routes, shareStore } = createRoutes(undefined, null, { sharedChatLimiter: undefined });
    const served = wrapRoutes(routes);
    const client = serverFor('192.0.2.1');
    const request = (search) => served['/api/v1/shared'].GET(new Request(`http://localhost/api/v1/shared${search}`), client);

    for (let attempt = 0; attempt < SHARED_CHAT_RATE_LIMIT_MAX_REQUESTS; attempt++) {
      expect((await request(`?token=missing-${attempt}`)).status).toBe(404);
    }
    const lookupsBeforeLimit = shareStore.getMessages.mock.calls.length;
    for (const search of ['?token=missing', '', '?token=share-token']) {
      const limited = await request(search);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe(String(SHARED_CHAT_RATE_LIMIT_WINDOW_MS / 1_000));
      expect(limited.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
      expect(limited.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
      expect(await limited.json()).toEqual({
        success: false, error: 'Too many requests. Please try again later.', errorCode: 'RATE_LIMITED', retryable: true,
      });
    }
    expect(shareStore.getMessages.mock.calls.length).toBe(lookupsBeforeLimit);
    expect((await served['/api/v1/shared'].GET(
      new Request('http://localhost/api/v1/shared?token=share-token'), serverFor('192.0.2.2'),
    )).status).toBe(200);
  });

  it('keys clients by forwarded address only when the proxy is trusted', async () => {
    const original = process.env.GARCON_TRUST_PROXY;
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const { routes } = createRoutes(undefined, null, { sharedChatLimiter: limiter });
    const statusFor = async (forwarded) => (
      await fetchShared(routes, '?token=missing', serverFor('192.0.2.3'), { 'x-forwarded-for': forwarded })
    ).status;
    try {
      process.env.GARCON_TRUST_PROXY = 'true';
      expect(await statusFor('198.51.100.1')).toBe(404);
      expect(await statusFor('198.51.100.2')).toBe(404);
      expect(await statusFor('198.51.100.1')).toBe(429);
      delete process.env.GARCON_TRUST_PROXY;
      expect(await statusFor('198.51.100.3')).toBe(404);
      expect(await statusFor('198.51.100.4')).toBe(429);
    } finally {
      limiter.dispose();
      if (original === undefined) delete process.env.GARCON_TRUST_PROXY;
      else process.env.GARCON_TRUST_PROXY = original;
    }
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
