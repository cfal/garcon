import { describe, expect, spyOn, test } from 'bun:test';
import crypto from 'node:crypto';
import type {
  AgentRunCommandRequest,
  AgentStopCommandRequest,
  PermissionDecisionCommandRequest,
  SteerCommandRequest,
} from '@garcon/common/chat-command-contracts';
import { runtimeProofPayload } from '@garcon/common/server-runtime';
import { DEFAULT_REMOTE_FEATURE_SETTINGS } from '@garcon/common/settings';
import { GarconClient, GarconHttpError, GarconTransportError } from '../garcon-client.js';

const connection = {
  baseUrl: 'http://127.0.0.1:8080',
  instanceId: 'instance',
  localCapability: 'garcon_local_secret',
  workspaceDir: '/config/workspace-default',
};

const runRequest: AgentRunCommandRequest = {
  clientRequestId: 'request',
  clientMessageId: 'message',
  chatId: '1785337200123456',
  command: 'Continue',
  tagsToAdd: ['cli'],
};

function accepted(request: AgentRunCommandRequest): Response {
  return Response.json({
    success: true,
    commandType: 'agent-run',
    clientRequestId: request.clientRequestId,
    chatId: request.chatId,
    turnId: 'turn-1',
    status: 'accepted',
    acceptedAt: new Date().toISOString(),
    parentChat: null,
    chat: null,
  });
}

function runtimeResponse(input: string | URL | Request, instanceId = connection.instanceId): Response {
  const url = new URL(input instanceof Request ? input.url : input);
  const challenge = url.searchParams.get('challenge') ?? '';
  const proof = crypto.createHmac('sha256', connection.localCapability)
    .update(runtimeProofPayload(instanceId, challenge))
    .digest('base64url');
  return Response.json({ schemaVersion: 1, instanceId, proof });
}

function validSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observedAt: '2026-08-04T12:00:00.000Z',
    messageLimit: 10,
    chat: {
      id: runRequest.chatId,
      title: 'Review',
      agentId: 'codex',
      agentOwnershipEpoch: 'epoch-1',
      carryOverRevision: 'carry-v1:0',
      model: 'gpt-5.4',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      projectPath: '/project',
      tags: ['cli'],
      canReloadFromNativeHistory: false,
      activity: { createdAt: null, lastActivityAt: null },
    },
    processingPhase: null,
    control: {
      serverInstanceId: connection.instanceId,
      queue: {
        entries: [],
        steeringEntryId: null,
        recentlyDispatched: [],
        pause: null,
        reorderRevision: 0,
      },
      version: 0,
      updatedAt: null,
    },
    transcript: {
      availability: 'available',
      transcriptViewId: 'view-1',
      messages: [],
      lastOrdinal: 0,
      pageOldestOrdinal: 0,
      pageNewestOrdinal: 0,
      nextBeforeOrdinal: null,
      hasMore: false,
    },
    transientFeed: {
      serverInstanceId: connection.instanceId,
      chatId: runRequest.chatId,
      transcriptViewId: 'view-1',
      transientRevision: 0,
      rows: [],
    },
    ...overrides,
  };
}

function validChatList(): Record<string, unknown> {
  return {
    sessions: [{
      id: runRequest.chatId,
      parentChat: null,
      agentId: 'codex',
      agentOwnershipEpoch: 'epoch-1',
      model: 'gpt-5.4',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
      title: 'Review',
      projectPath: '/project',
      orderGroup: 'normal',
      tags: ['cli'],
      activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
      preview: { firstMessage: 'Review', lastMessage: 'Done' },
      isPinned: false,
      isArchived: false,
      isActive: false,
      isProcessing: false,
      processingPhase: null,
      canReloadFromNativeHistory: false,
      isUnread: false,
    }],
    total: 1,
    lastSelectedChatId: runRequest.chatId,
  };
}

function validHistory(): Record<string, unknown> {
  return {
    historyState: { kind: 'complete' },
    chatId: runRequest.chatId,
    transcriptViewId: 'view-1',
    messages: [{
      ordinal: 84,
      message: {
        type: 'assistant-message',
        timestamp: '2026-09-07T00:00:00.000Z',
        content: 'answer',
      },
    }],
    resendCandidates: [],
    lastOrdinal: 100,
    pageOldestOrdinal: 84,
    pageNewestOrdinal: 100,
    nextBeforeOrdinal: 51,
    hasMore: true,
    limit: 50,
  };
}

function validSearch(): Record<string, unknown> {
  return {
    query: 'needle',
    mode: 'page',
    snippetLimit: 1,
    results: [{
      chatId: runRequest.chatId,
      transcriptViewId: 'view-1',
      score: 1,
      matchedMessageCount: 1,
      snippets: [{
        ordinal: 84,
        role: 'assistant',
        timestamp: '2026-09-07T00:00:00.000Z',
        text: 'needle',
      }],
    }],
    page: { offset: 0, limit: 20, total: 1, hasMore: false, nextOffset: null },
    index: {
      indexedChatCount: 1,
      pendingChatCount: 0,
      failedChatCount: 0,
      unindexedChatCount: 0,
      unsupportedChatCount: 0,
      resultsTruncated: false,
      failedChats: [],
      failedChatsOmittedCount: 0,
    },
    removedStaleResultCount: 0,
  };
}

function validSearchStatus(): Record<string, unknown> {
  return {
    version: 1,
    phase: 'ready',
    chats: { total: 1, indexed: 1, pending: 0, failed: 0, unindexed: 0 },
    queuedJobs: 0,
    resync: null,
    backlogRows: 0,
    activeChat: null,
    lastErrorCode: null,
    updatedAt: '2026-09-08T00:00:00.000Z',
    queryStats: {
      served: 2,
      timedOut: 0,
      rejectedBusy: 0,
      p50Ms: 10,
      p95Ms: 20,
      maxMs: 20,
      admissionP50Ms: 1,
      admissionP95Ms: 2,
      admissionMaxMs: 2,
      totalP50Ms: 11,
      totalP95Ms: 22,
      totalMaxMs: 22,
    },
  };
}

function validRemoteSettings(enabled: boolean): Record<string, unknown> {
  return {
    version: 2,
    features: {
      ...DEFAULT_REMOTE_FEATURE_SETTINGS,
      transcriptSearch: { enabled },
    },
    ui: {},
    uiEffective: {},
    paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
    pinnedChatIds: [],
    recentAgentSettings: [],
    executionDefaults: {
      global: { permissionMode: 'default', thinkingMode: 'none', agentSettingsById: {} },
      byAgent: {},
    },
    projectBasePath: '/project',
    telegram: {
      botTokenAvailable: false,
      botUsername: null,
      botFirstName: null,
      recipientUsername: null,
      recipientDisplayName: null,
      recipientLinked: false,
      pendingLink: false,
      linkUrl: null,
    },
  };
}

describe('GarconClient', () => {
  test('fetches and validates the preamble catalog', async () => {
    const snapshot = {
      revision: 1,
      preambles: [{
        id: '3502b645-222b-49d2-ac39-1c91f9fb1174',
        enabled: true,
        title: 'Repository guidance',
        content: 'Follow the repository guidance.',
        scope: { type: 'global' },
        agentIds: [],
        tagFilter: { mode: 'all', tags: [] },
        createdAt: '2026-09-08T00:00:00.000Z',
        updatedAt: '2026-09-08T00:00:00.000Z',
      }],
    };
    let requestedUrl = '';
    const client = new GarconClient({
      ...connection,
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json(snapshot);
      },
    });

    await expect(client.getPreambles()).resolves.toEqual(snapshot);
    expect(requestedUrl).toBe(`${connection.baseUrl}/api/v1/preambles`);

    const malformed = new GarconClient({
      ...connection,
      fetch: async () => Response.json({ ...snapshot, revision: -1 }),
    });
    await expect(malformed.getPreambles()).rejects.toMatchObject({
      phase: 'catalog resolution',
      exitCode: 3,
    });
  });

  test('fetches and strictly validates the complete chat catalog', async () => {
    let requestedUrl = '';
    const client = new GarconClient({
      ...connection,
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json(validChatList());
      },
    });
    await expect(client.listChats()).resolves.toMatchObject({ total: 1 });
    expect(requestedUrl).toBe(`${connection.baseUrl}/api/v1/chats`);

    const malformed = new GarconClient({
      ...connection,
      fetch: async () => Response.json({ ...validChatList(), total: 2 }),
    });
    await expect(malformed.listChats()).rejects.toMatchObject({
      phase: 'chat discovery',
      exitCode: 3,
    });
  });

  test('fetches and validates a view-qualified transcript page', async () => {
    let requestedUrl = '';
    const client = new GarconClient({
      ...connection,
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json(validHistory());
      },
    });
    await expect(client.getChatMessages({
      chatId: runRequest.chatId,
      transcriptViewId: 'view-1',
      beforeOrdinal: 101,
      limit: 50,
    })).resolves.toMatchObject({ transcriptViewId: 'view-1', lastOrdinal: 100 });
    expect(requestedUrl).toBe(
      `${connection.baseUrl}/api/v1/chats/messages?chatId=${runRequest.chatId}&limit=50&beforeOrdinal=101&transcriptViewId=view-1`,
    );

    const malformed = new GarconClient({
      ...connection,
      fetch: async () => Response.json({ ...validHistory(), transcriptViewId: 'view-2' }),
    });
    await expect(malformed.getChatMessages({
      chatId: runRequest.chatId,
      transcriptViewId: 'view-1',
      beforeOrdinal: 101,
      limit: 50,
    })).rejects.toMatchObject({ phase: 'chat read', exitCode: 3 });
  });

  test('posts and validates a request-correlated transcript search', async () => {
    let submitted: unknown;
    const client = new GarconClient({
      ...connection,
      fetch: async (_input, init) => {
        submitted = JSON.parse(String(init?.body));
        return Response.json(validSearch());
      },
    });
    const request = {
      query: 'needle',
      mode: 'page' as const,
      offset: 0,
      limit: 20,
      snippetLimit: 1,
    };
    await expect(client.searchChats(request)).resolves.toMatchObject({
      query: 'needle',
      results: [{ chatId: runRequest.chatId }],
    });
    expect(submitted).toEqual(request);

    const malformed = new GarconClient({
      ...connection,
      fetch: async () => Response.json({
        ...validSearch(),
        page: { ...validSearch().page as object, offset: 1 },
      }),
    });
    await expect(malformed.searchChats(request)).rejects.toMatchObject({
      phase: 'chat search',
      exitCode: 3,
    });

    const invalid = new GarconClient({
      ...connection,
      fetch: async () => Response.json({
        success: false,
        error: 'Search query has too many terms',
        errorCode: 'VALIDATION_FAILED',
        retryable: false,
      }, { status: 400 }),
    });
    await expect(invalid.searchChats(request)).rejects.toMatchObject({
      phase: 'chat search',
      exitCode: 2,
      errorCode: 'VALIDATION_FAILED',
    });
  });

  test('fetches and strictly validates transcript search status', async () => {
    let requestedUrl = '';
    const client = new GarconClient({
      ...connection,
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json(validSearchStatus());
      },
    });

    await expect(client.getTranscriptSearchStatus()).resolves.toEqual(validSearchStatus());
    expect(requestedUrl).toBe(`${connection.baseUrl}/api/v1/chats/search/status`);

    const malformed = new GarconClient({
      ...connection,
      fetch: async () => Response.json({
        ...validSearchStatus(),
        queryStats: { ...(validSearchStatus().queryStats as object), served: '2' },
      }),
    });
    await expect(malformed.getTranscriptSearchStatus()).rejects.toMatchObject({
      phase: 'chat search',
      exitCode: 3,
    });
  });

  test('rebuilds transcript search and strictly validates the returned status', async () => {
    let requestedUrl = '';
    let method = '';
    const response = { success: true, status: validSearchStatus() };
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        requestedUrl = String(input);
        method = init?.method ?? '';
        return Response.json(response);
      },
    });

    await expect(client.rebuildTranscriptSearch()).resolves.toEqual(response);
    expect(requestedUrl).toBe(`${connection.baseUrl}/api/v1/chats/search/rebuild`);
    expect(method).toBe('POST');

    for (const value of [
      { ...response, success: false },
      { ...response, status: { ...validSearchStatus(), phase: 'unknown' } },
    ]) {
      const malformed = new GarconClient({
        ...connection,
        fetch: async () => Response.json(value),
      });
      await expect(malformed.rebuildTranscriptSearch()).rejects.toMatchObject({
        phase: 'chat search',
        exitCode: 3,
      });
    }
  });

  test('updates transcript search through the settings contract and verifies desired state', async () => {
    let requestedUrl = '';
    let submitted: unknown;
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        requestedUrl = String(input);
        submitted = JSON.parse(String(init?.body));
        return Response.json({ success: true, settings: validRemoteSettings(true) });
      },
    });

    await expect(client.setTranscriptSearchEnabled(true)).resolves.toMatchObject({
      version: 2,
      features: { transcriptSearch: { enabled: true } },
    });
    expect(requestedUrl).toBe(`${connection.baseUrl}/api/v1/app/settings`);
    expect(submitted).toEqual({ features: { transcriptSearch: { enabled: true } } });

    for (const value of [
      { success: true, settings: validRemoteSettings(false) },
      { success: false, settings: validRemoteSettings(true) },
      { success: true, settings: { ...validRemoteSettings(true), features: {} } },
    ]) {
      const malformed = new GarconClient({
        ...connection,
        fetch: async () => Response.json(value),
      });
      await expect(malformed.setTranscriptSearchEnabled(true)).rejects.toMatchObject({
        phase: 'chat search',
        exitCode: 3,
      });
    }
  });

  test('leaves transcript search maintenance unbounded', async () => {
    const timeout = spyOn(AbortSignal, 'timeout');
    const signals: (AbortSignal | null | undefined)[] = [];
    const responses = [
      { success: true, status: validSearchStatus() },
      { success: true, settings: validRemoteSettings(true) },
    ];
    const client = new GarconClient({
      ...connection,
      fetch: async (_input, init) => {
        signals.push(init?.signal);
        await Promise.resolve();
        return Response.json(responses.shift());
      },
    });

    try {
      await client.rebuildTranscriptSearch();
      await client.setTranscriptSearchEnabled(true);

      expect(timeout).not.toHaveBeenCalled();
      expect(signals).toEqual([undefined, undefined]);
    } finally {
      timeout.mockRestore();
    }
  });

  test('preserves caller cancellation for transcript search maintenance', async () => {
    const controller = new AbortController();
    const reason = new Error('maintenance cancelled');
    const client = new GarconClient({
      ...connection,
      fetch: async (_input, init) => {
        const signal = init?.signal;
        expect(signal).toBe(controller.signal);
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    const request = client.rebuildTranscriptSearch(controller.signal);
    await Promise.resolve();
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
  });

  test('fetches and validates a correlated transcript export', async () => {
    let requestedUrl = '';
    const client = new GarconClient({
      ...connection,
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json(validExport());
      },
    });

    await expect(client.getTranscriptExport({
      chatId: runRequest.chatId,
      format: 'xml',
      exclusions: ['tool-calls', 'reasoning'],
    })).resolves.toMatchObject({ format: 'xml', entryCount: 1 });
    expect(requestedUrl).toBe(
      `${connection.baseUrl}/api/v1/chats/export?chatId=${runRequest.chatId}&format=xml&exclude=tool-calls&exclude=reasoning`,
    );
  });

  test('rejects malformed and uncorrelated transcript exports', async () => {
    for (const response of [
      { ...validExport(), document: 'missing newline' },
      { ...validExport(), chatId: '1785337200123457' },
      { ...validExport(), exclusions: [], omitted: [] },
    ]) {
      const client = new GarconClient({ ...connection, fetch: async () => Response.json(response) });
      await expect(client.getTranscriptExport({
        chatId: runRequest.chatId,
        format: 'xml',
        exclusions: ['tool-calls', 'reasoning'],
      })).rejects.toBeInstanceOf(Error);
    }
  });

  test('maps export validation failures to an argument-level exit', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({
        success: false,
        error: 'Invalid filter',
        errorCode: 'VALIDATION_FAILED',
        retryable: false,
      }, { status: 400 }),
    });
    await expect(client.getTranscriptExport({
      chatId: runRequest.chatId,
      format: 'markdown',
      exclusions: [],
    })).rejects.toMatchObject({ phase: 'export', exitCode: 2 });
  });

  test('fetches and validates a correlated handoff artifact', async () => {
    let requestedUrl = '';
    const client = new GarconClient({
      ...connection,
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json(validHandoffArtifact());
      },
    });

    await expect(client.getChatHandoffArtifact({
      chatId: runRequest.chatId,
      contextWindowTokens: 131_072,
    })).resolves.toMatchObject({
      chatId: runRequest.chatId,
      contextWindowTokens: 131_072,
      usableTokenBudget: 98_304,
    });
    expect(requestedUrl).toBe(
      `${connection.baseUrl}/api/v1/chats/handoff-artifact?chatId=${runRequest.chatId}&contextWindowTokens=131072`,
    );
  });

  test('rejects malformed and uncorrelated handoff artifacts', async () => {
    for (const response of [
      { ...validHandoffArtifact(), document: 'missing newline' },
      { ...validHandoffArtifact(), chatId: '1785337200123457' },
      { ...validHandoffArtifact(), contextWindowTokens: 200_000, usableTokenBudget: 150_000 },
    ]) {
      const client = new GarconClient({ ...connection, fetch: async () => Response.json(response) });
      await expect(client.getChatHandoffArtifact({
        chatId: runRequest.chatId,
        contextWindowTokens: 131_072,
      })).rejects.toMatchObject({ phase: 'handoff artifact', exitCode: 3 });
    }
  });

  test('maps handoff validation failures to an argument-level exit', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({
        success: false,
        error: 'Invalid context window',
        errorCode: 'VALIDATION_FAILED',
        retryable: false,
      }, { status: 400 }),
    });
    await expect(client.getChatHandoffArtifact({
      chatId: runRequest.chatId,
      contextWindowTokens: 131_072,
    })).rejects.toMatchObject({ phase: 'handoff artifact', exitCode: 2 });
  });

  test('posts an authenticated native session lookup and validates the response', async () => {
    let request: {
      url: string;
      method: string | undefined;
      authorization: string | null;
      contentType: string | null;
      body: unknown;
    } | undefined;
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        request = {
          url: String(input),
          method: init?.method,
          authorization: headers.get('authorization'),
          contentType: headers.get('content-type'),
          body: JSON.parse(String(init?.body)),
        };
        return Response.json({ chatId: runRequest.chatId });
      },
    });

    await expect(client.lookupNativeSession({
      nativeSessionId: 'session-123',
      agent: 'codex',
    })).resolves.toBe(runRequest.chatId);
    expect(request).toEqual({
      url: `${connection.baseUrl}/api/v1/chats/lookup-native-session`,
      method: 'POST',
      authorization: `Bearer ${connection.localCapability}`,
      contentType: 'application/json',
      body: { nativeSessionId: 'session-123', agent: 'codex' },
    });
  });

  test.each([
    {},
    { chatId: '123' },
    { chatId: 1785337200123456 },
  ])('rejects malformed native session lookup response %p', async (body) => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json(body),
    });

    await expect(client.lookupNativeSession({ nativeSessionId: 'session-123' }))
      .rejects.toMatchObject({
        phase: 'native session lookup',
        exitCode: 3,
        message: 'server returned an invalid native session lookup response',
      });
  });

  test.each([
    [404, 'NATIVE_SESSION_NOT_FOUND'],
    [409, 'NATIVE_SESSION_AMBIGUOUS'],
    [422, 'UNSUPPORTED_AGENT'],
  ])('maps native session lookup HTTP %i %s to exit 2', async (status, errorCode) => {
    let calls = 0;
    const client = new GarconClient({
      ...connection,
      fetch: async () => {
        calls += 1;
        return Response.json({
          success: false,
          error: 'Lookup failed',
          errorCode,
          retryable: false,
        }, { status });
      },
    });

    await expect(client.lookupNativeSession({ nativeSessionId: 'session-123' }))
      .rejects.toMatchObject({ phase: 'native session lookup', exitCode: 2, errorCode });
    expect(calls).toBe(1);
  });

  test('distinguishes native session lookup authentication and transport failures', async () => {
    const authenticationClient = new GarconClient({
      ...connection,
      fetch: async () => Response.json({
        success: false,
        error: 'Invalid token',
        errorCode: 'VALIDATION_FAILED',
        retryable: false,
      }, { status: 401 }),
    });
    await expect(authenticationClient.lookupNativeSession({ nativeSessionId: 'session-123' }))
      .rejects.toMatchObject({ phase: 'authentication', exitCode: 3 });

    const transportClient = new GarconClient({
      ...connection,
      fetch: async () => { throw new TypeError('connection refused'); },
    });
    await expect(transportClient.lookupNativeSession({ nativeSessionId: 'session-123' }))
      .rejects.toMatchObject({ phase: 'native session lookup', exitCode: 3 });
  });

  test('fetches and validates a correlated chat snapshot', async () => {
    let request: { url: string; method: string | undefined; authorization: string | null } | undefined;
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        request = {
          url: String(input),
          method: init?.method,
          authorization: new Headers(init?.headers).get('authorization'),
        };
        return Response.json(validSnapshot());
      },
    });

    await expect(client.getChatSnapshot(runRequest.chatId, 10)).resolves.toMatchObject({
      chat: { id: runRequest.chatId },
      messageLimit: 10,
    });
    expect(request).toEqual({
      url: `${connection.baseUrl}/api/v1/chats/snapshot?chatId=${runRequest.chatId}&limit=10`,
      method: 'GET',
      authorization: `Bearer ${connection.localCapability}`,
    });
  });

  test.each([
    ['chat ID', () => validSnapshot({
      chat: { ...validSnapshot().chat as object, id: '1785337200123457' },
      transientFeed: {
        ...validSnapshot().transientFeed as object,
        chatId: '1785337200123457',
      },
    })],
    ['message limit', () => validSnapshot({ messageLimit: 9 })],
    ['server instance', () => validSnapshot({
      control: { ...validSnapshot().control as object, serverInstanceId: 'other-instance' },
    })],
  ])('rejects an uncorrelated snapshot by %s', async (_label, response) => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json(response()),
    });

    await expect(client.getChatSnapshot(runRequest.chatId, 10))
      .rejects.toThrow('uncorrelated chat snapshot');
  });

  test('rejects a malformed chat snapshot contract', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json(validSnapshot({ processingPhase: 'busy' })),
    });

    await expect(client.getChatSnapshot(runRequest.chatId, 10))
      .rejects.toThrow('invalid chat snapshot');
  });

  test('maps a missing snapshot to an argument-level exit', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({
        success: false,
        error: 'Session not found',
        errorCode: 'SESSION_NOT_FOUND',
        retryable: false,
      }, { status: 404 }),
    });

    try {
      await client.getChatSnapshot(runRequest.chatId, 10);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(GarconHttpError);
      expect((error as GarconHttpError).phase).toBe('chat status');
      expect((error as GarconHttpError).exitCode).toBe(2);
    }
  });

  test('authenticates requests with the process capability', async () => {
    let authorization: string | null = null;
    let redirect: RequestRedirect | undefined;
    const client = new GarconClient({
      ...connection,
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization');
        redirect = init?.redirect;
        return accepted(runRequest);
      },
    });
    expect((await client.runChat(runRequest)).turnId).toBe('turn-1');
    expect(authorization).toBe('Bearer garcon_local_secret');
    expect(redirect).toBe('error');
  });

  test.each([
    { status: 'applied', addedTags: ['cli'] },
    { status: 'not-applied', errorCode: 'CHAT_TAG_SAVE_FAILED', retryable: true },
    { status: 'unknown', errorCode: 'CHAT_TAG_SAVE_UNKNOWN', recoveryRequired: true },
  ] as const)('preserves the $status post-admission tag outcome', async (tagMutation) => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({
        success: true,
        commandType: 'agent-run',
        clientRequestId: runRequest.clientRequestId,
        chatId: runRequest.chatId,
        turnId: 'turn-1',
        status: 'accepted',
        acceptedAt: new Date().toISOString(),
        tagMutation,
      }),
    });

    await expect(client.runChat(runRequest)).resolves.toMatchObject({ tagMutation });
  });

  test('updates a chat title through the existing workspace API', async () => {
    let request: { url: string; method: string | undefined; body: string } | undefined;
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        request = {
          url: String(input),
          method: init?.method,
          body: String(init?.body),
        };
        return Response.json({
          success: true,
          chatId: runRequest.chatId,
          title: 'Delegated review',
          changed: true,
        });
      },
    });

    await expect(client.updateChatTitle({
      chatId: runRequest.chatId,
      title: 'Delegated review',
    })).resolves.toMatchObject({ title: 'Delegated review', changed: true });

    expect(request).toEqual({
      url: `${connection.baseUrl}/api/v1/app/session-name`,
      method: 'PUT',
      body: JSON.stringify({ chatId: runRequest.chatId, title: 'Delegated review' }),
    });
  });

  test('uses desired-state metadata routes and strictly correlates their responses', async () => {
    const requests: Array<{ url: string; method: string | undefined; body: string }> = [];
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, method: init?.method, body: String(init?.body) });
        if (url.endsWith('/api/v1/chats/pin')) {
          return Response.json({
            success: true,
            chatId: runRequest.chatId,
            orderGroup: 'pinned',
            isPinned: true,
            isArchived: false,
            changed: true,
          });
        }
        if (url.endsWith('/api/v1/chats/archive')) {
          return Response.json({
            success: true,
            chatId: runRequest.chatId,
            orderGroup: 'archived',
            isPinned: false,
            isArchived: true,
            changed: true,
          });
        }
        return Response.json({
          success: true,
          chatId: runRequest.chatId,
          tags: ['automation', 'review'],
          changed: true,
        });
      },
    });

    await expect(client.setChatPinned({ chatId: runRequest.chatId, isPinned: true }))
      .resolves.toMatchObject({ orderGroup: 'pinned', changed: true });
    await expect(client.setChatArchived({ chatId: runRequest.chatId, isArchived: true }))
      .resolves.toMatchObject({ orderGroup: 'archived', changed: true });
    await expect(client.setChatTags({
      chatId: runRequest.chatId,
      tags: ['automation', 'review'],
    })).resolves.toMatchObject({ tags: ['automation', 'review'], changed: true });

    expect(requests).toEqual([
      {
        url: `${connection.baseUrl}/api/v1/chats/pin`,
        method: 'PUT',
        body: JSON.stringify({ chatId: runRequest.chatId, isPinned: true }),
      },
      {
        url: `${connection.baseUrl}/api/v1/chats/archive`,
        method: 'PUT',
        body: JSON.stringify({ chatId: runRequest.chatId, isArchived: true }),
      },
      {
        url: `${connection.baseUrl}/api/v1/chats/tags`,
        method: 'PATCH',
        body: JSON.stringify({ chatId: runRequest.chatId, tags: ['automation', 'review'] }),
      },
    ]);
  });

  test('retries an ambiguous permission decision byte-for-byte and accepts its duplicate receipt', async () => {
    const request: PermissionDecisionCommandRequest = {
      clientRequestId: 'permission-v1:request',
      chatId: runRequest.chatId,
      permissionOccurrenceId: 'occurrence-1',
      allow: false,
      alwaysAllow: false,
      control: {
        serverInstanceId: connection.instanceId,
        chatId: runRequest.chatId,
        runId: 'run-1',
        permissionOccurrenceId: 'occurrence-1',
      },
    };
    const bodies: string[] = [];
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input, init) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        bodies.push(String(init?.body));
        if (attempts === 1) throw new TypeError('connection reset');
        return Response.json({
          success: true,
          commandType: 'permission-decision',
          clientRequestId: request.clientRequestId,
          chatId: request.chatId,
          status: 'duplicate',
          acceptedAt: '2026-09-08T00:00:00.000Z',
        });
      },
    });

    await expect(client.decidePermission(request)).resolves.toMatchObject({ status: 'duplicate' });
    expect(attempts).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('does not retry a definitive stale permission decision', async () => {
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async () => {
        attempts += 1;
        return Response.json({
          success: false,
          error: 'Permission request is no longer actionable',
          errorCode: 'PERMISSION_NOT_ACTIONABLE',
          retryable: false,
        }, { status: 409 });
      },
    });

    await expect(client.decidePermission({
      clientRequestId: 'permission-v1:stale',
      chatId: runRequest.chatId,
      permissionOccurrenceId: 'occurrence-stale',
      allow: false,
      alwaysAllow: false,
      control: {
        serverInstanceId: connection.instanceId,
        chatId: runRequest.chatId,
        runId: 'run-stale',
        permissionOccurrenceId: 'occurrence-stale',
      },
    })).rejects.toMatchObject({
      status: 409,
      errorCode: 'PERMISSION_NOT_ACTIONABLE',
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  test('retries an ambiguous submission with the identical request body', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input, init) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        bodies.push(String(init?.body));
        if (attempts === 1) throw new TypeError('connection reset');
        return accepted(runRequest);
      },
    });
    await client.runChat(runRequest);
    expect(attempts).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('retries when an accepted response body is interrupted', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input, init) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        bodies.push(String(init?.body));
        if (attempts === 1) {
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"success":true'));
              controller.error(new TypeError('connection reset'));
            },
          }), { status: 202, headers: { 'Content-Type': 'application/json' } });
        }
        return accepted(runRequest);
      },
    });

    await expect(client.runChat(runRequest)).resolves.toMatchObject({ turnId: 'turn-1' });
    expect(attempts).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('classifies an interrupted receipt body as a transport failure', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.error(new TypeError('connection reset'));
        },
      }), { status: 200 }),
    });

    await expect(client.getTurnReceipt(runRequest.chatId, 'turn-1'))
      .rejects.toBeInstanceOf(GarconTransportError);
  });

  test('retries a malformed successful submission response with the exact body', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input, init) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        bodies.push(String(init?.body));
        return attempts === 1
          ? Response.json({ success: true })
          : accepted(runRequest);
      },
    });
    await expect(client.runChat(runRequest)).resolves.toMatchObject({ turnId: 'turn-1' });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('reports the candidate chat after ambiguous recovery is exhausted', async () => {
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        return new Response('{"success":', { status: 202 });
      },
    });

    await expect(client.runChat(runRequest)).rejects.toThrow(
      `chat ${runRequest.chatId} may still be running`,
    );
    expect(attempts).toBe(3);
  });

  test.each([408, 425, 429, 500, 502, 503, 504])('retries ambiguous HTTP %i responses', async (status) => {
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        return attempts === 1
          ? Response.json({ error: 'try again' }, { status })
          : accepted(runRequest);
      },
    });

    await expect(client.runChat(runRequest)).resolves.toMatchObject({ turnId: 'turn-1' });
    expect(attempts).toBe(2);
  });

  test('does not retry an ambiguous submission on a replacement runtime', async () => {
    let submissions = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) {
          return runtimeResponse(input, 'replacement-instance');
        }
        submissions += 1;
        throw new TypeError('connection reset');
      },
    });

    await expect(client.runChat(runRequest)).rejects.toThrow(
      `chat ${runRequest.chatId} may have been accepted`,
    );
    expect(submissions).toBe(1);
  });

  test('does not confuse a retryable busy admission with an ambiguous outcome', async () => {
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      fetch: async () => {
        attempts += 1;
        return Response.json({
          success: false,
          error: 'Chat is busy',
          errorCode: 'SESSION_BUSY',
          retryable: true,
        }, { status: 409 });
      },
    });
    await expect(client.runChat(runRequest)).rejects.toBeInstanceOf(GarconHttpError);
    expect(attempts).toBe(1);
  });

  test('parses Retry-After for receipt recovery', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({ error: 'busy' }, {
        status: 503,
        headers: { 'Retry-After': '3' },
      }),
    });

    try {
      await client.getTurnReceipt(runRequest.chatId, 'turn-1');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(GarconHttpError);
      expect((error as GarconHttpError).retryAfterMs).toBe(3_000);
    }
  });

  test('caps Retry-After values used by recovery', async () => {
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({ error: 'busy' }, {
        status: 503,
        headers: { 'Retry-After': '31536000' },
      }),
    });

    try {
      await client.getTurnReceipt(runRequest.chatId, 'turn-1');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(GarconHttpError);
      expect((error as GarconHttpError).retryAfterMs).toBe(5_000);
    }
  });

  test('does not accept a response without correlated fields', async () => {
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => String(input).includes('/api/v1/runtime')
        ? runtimeResponse(input)
        : Response.json({ success: true, status: 'accepted' }),
    });
    await expect(client.runChat(runRequest)).rejects.toThrow('may still be running');
  });

  test('recovers from an accepted response for a different request', async () => {
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        return attempts === 1
          ? Response.json({
            ...await accepted(runRequest).json(),
            clientRequestId: 'other',
          })
          : accepted(runRequest);
      },
    });
    await expect(client.runChat(runRequest)).resolves.toMatchObject({ turnId: 'turn-1' });
    expect(attempts).toBe(2);
  });

  const steerRequest: SteerCommandRequest = {
    clientRequestId: 'steer-request',
    clientMessageId: 'steer-message',
    chatId: runRequest.chatId,
    content: 'Follow up',
  };

  function steerAccepted(request: SteerCommandRequest): Response {
    return Response.json({
      success: true,
      commandType: 'steer',
      clientRequestId: request.clientRequestId,
      chatId: request.chatId,
      turnId: 'turn-active',
      parentChat: null,
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
    });
  }

  test('submits a steer to the existing endpoint with the exact body', async () => {
    let request: { url: string; method: string | undefined; body: string } | undefined;
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        request = { url: String(input), method: init?.method, body: String(init?.body) };
        return steerAccepted(steerRequest);
      },
    });

    await expect(client.steerChat(steerRequest)).resolves.toMatchObject({
      commandType: 'steer',
      turnId: 'turn-active',
    });
    expect(request).toEqual({
      url: `${connection.baseUrl}/api/v1/chats/steer`,
      method: 'POST',
      body: JSON.stringify(steerRequest),
    });
  });

  test('does not retry a recorded unknown steering outcome', async () => {
    let submissions = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async () => {
        submissions += 1;
        return Response.json({
          success: false,
          error: 'Steering delivery could not be confirmed.',
          errorCode: 'STEER_OUTCOME_UNKNOWN',
          retryable: false,
        }, { status: 500 });
      },
    });

    await expect(client.steerChat(steerRequest)).rejects.toBeInstanceOf(GarconHttpError);
    expect(submissions).toBe(1);
  });

  test('does not retry a definitively non-delivered steering outcome', async () => {
    let submissions = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async () => {
        submissions += 1;
        return Response.json({
          success: false,
          error: 'Steering delivery failed.',
          errorCode: 'STEER_NOT_DELIVERED',
          retryable: false,
        }, { status: 502 });
      },
    });

    await expect(client.steerChat(steerRequest)).rejects.toBeInstanceOf(GarconHttpError);
    expect(submissions).toBe(1);
  });

  test('retries an ambiguous errorCode-less steer submission with the exact body', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input, init) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        bodies.push(String(init?.body));
        return attempts === 1
          ? Response.json({ error: 'try again' }, { status: 503 })
          : steerAccepted(steerRequest);
      },
    });

    await expect(client.steerChat(steerRequest)).resolves.toMatchObject({ turnId: 'turn-active' });
    expect(attempts).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('does not accept a steer response without a correlated turn identity', async () => {
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => String(input).includes('/api/v1/runtime')
        ? runtimeResponse(input)
        : Response.json({ success: true, status: 'accepted' }),
    });
    await expect(client.steerChat(steerRequest)).rejects.toThrow('may still be running');
  });

  const stopRequest: AgentStopCommandRequest = {
    clientRequestId: 'stop-request',
    chatId: runRequest.chatId,
  };

  const validControl = {
    serverInstanceId: 'instance',
    queue: {
      entries: [],
      steeringEntryId: null,
      recentlyDispatched: [],
      pause: null,
      reorderRevision: 0,
    },
    version: 0,
    updatedAt: null,
  };

  function stopAccepted(overrides: Record<string, unknown> = {}): Response {
    return Response.json({
      success: true,
      commandType: 'agent-stop',
      clientRequestId: stopRequest.clientRequestId,
      chatId: stopRequest.chatId,
      parentChat: null,
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
      outcome: 'interrupt-requested',
      control: validControl,
      ...overrides,
    });
  }

  test('parses and correlates a stop response', async () => {
    let request: { url: string; method: string | undefined; body: string } | undefined;
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        request = { url: String(input), method: init?.method, body: String(init?.body) };
        return stopAccepted();
      },
    });

    await expect(client.stopChat(stopRequest)).resolves.toMatchObject({
      outcome: 'interrupt-requested',
      control: validControl,
    });
    expect(request).toEqual({
      url: `${connection.baseUrl}/api/v1/chats/stop`,
      method: 'POST',
      body: JSON.stringify(stopRequest),
    });
  });

  test('retries an ambiguous stop submission with the exact request', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input, init) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        attempts += 1;
        bodies.push(String(init?.body));
        if (attempts === 1) throw new TypeError('connection reset');
        return stopAccepted();
      },
    });

    await expect(client.stopChat(stopRequest)).resolves.toMatchObject({ outcome: 'interrupt-requested' });
    expect(attempts).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  test('never accepts a stop response with a malformed outcome', async () => {
    let submissions = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        submissions += 1;
        return stopAccepted({ outcome: 'stopped-somehow' });
      },
    });

    await expect(client.stopChat(stopRequest)).rejects.toThrow(
      `chat ${stopRequest.chatId} may still be running`,
    );
    expect(submissions).toBe(3);
  });

  test('never accepts a stop response with a malformed control state', async () => {
    let submissions = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) return runtimeResponse(input);
        submissions += 1;
        return stopAccepted({ control: { serverInstanceId: 'instance' } });
      },
    });

    await expect(client.stopChat(stopRequest)).rejects.toThrow(
      `chat ${stopRequest.chatId} may still be running`,
    );
    expect(submissions).toBe(3);
  });

  test('does not retry a stop submission against a replacement runtime', async () => {
    let submissions = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input) => {
        if (String(input).includes('/api/v1/runtime')) {
          return runtimeResponse(input, 'replacement-instance');
        }
        submissions += 1;
        throw new TypeError('connection reset');
      },
    });

    await expect(client.stopChat(stopRequest)).rejects.toThrow(
      `chat ${stopRequest.chatId} may have been accepted`,
    );
    expect(submissions).toBe(1);
  });
});

function validExport(): Record<string, unknown> {
  return {
    success: true,
    chatId: runRequest.chatId,
    format: 'xml',
    transcriptViewId: 'view-1',
    lastOrdinal: 3,
    generatedAt: '2026-08-23T00:00:00.000Z',
    entryCount: 1,
    totalEntryCount: 3,
    exclusions: ['tool-calls', 'reasoning'],
    omitted: [
      { category: 'tool-calls', count: 1 },
      { category: 'reasoning', count: 1 },
    ],
    document: '<?xml version="1.0"?>\n',
  };
}

function validHandoffArtifact(): Record<string, unknown> {
  const document = '<handoff-artifact/>\n';
  return {
    success: true,
    chatId: runRequest.chatId,
    transcriptViewId: 'view-1',
    lastOrdinal: 3,
    generatedAt: '2026-08-23T00:00:00.000Z',
    contextWindowTokens: 131_072,
    usableTokenBudget: 98_304,
    estimatedTokens: 10,
    fold: 'handoff-v1',
    gapUnit: 'eligible-entry',
    sourceEntryCount: 2,
    eligibleEntryCount: 2,
    excludedEntryCounts: [],
    includedEntryCount: 2,
    budgetOmittedEntryCount: 0,
    abridgedEntryCount: 0,
    gapCount: 0,
    projectionTruncated: false,
    documentCodeUnits: document.length,
    document,
  };
}

describe('GarconClient add-row', () => {
  const addRequest = {
    clientRequestId: 'row-request',
    clientMessageId: 'row-message',
    chatId: runRequest.chatId,
    transcriptViewId: 'view-1',
    presentation: { style: 'error' as const },
    format: 'plain' as const,
    disclosure: 'collapsed' as const,
    title: 'Release validation',
    content: 'durable error',
  };

  test('validates the target and correlates every mutation identity', async () => {
    const seen: Array<{ url: string; body: string | null }> = [];
    const client = new GarconClient({
      ...connection,
      fetch: async (input, init) => {
        const url = String(input);
        seen.push({ url, body: init?.body ? String(init.body) : null });
        if (url.includes('?chatId=')) {
          return Response.json({
            success: true,
            chatId: runRequest.chatId,
            transcriptViewId: 'view-1',
          });
        }
        const body = JSON.parse(String(init?.body));
        return Response.json({
          success: true,
          commandType: 'chat-row-add',
          ...body,
          ordinal: 3,
          status: 'appended',
          timestamp: '2026-08-18T00:00:00.000Z',
        });
      },
    });

    await expect(client.getChatRowTarget(runRequest.chatId)).resolves.toMatchObject({
      transcriptViewId: 'view-1',
    });
    await expect(client.addChatRow(addRequest)).resolves.toMatchObject({
      ordinal: 3,
      status: 'appended',
    });
    expect(seen[1]?.body).toBe(JSON.stringify(addRequest));
  });

  test('correlates custom presentation independently of object key order', async () => {
    const customRequest = {
      ...addRequest,
      presentation: {
        style: 'custom' as const,
        customStyle: {
          lightAccent: '#7c3aed' as const,
          darkAccent: '#c4b5fd' as const,
        },
      },
      format: 'markdown' as const,
      content: '**complete**',
    };
    const client = new GarconClient({
      ...connection,
      fetch: async () => Response.json({
        success: true,
        commandType: 'chat-row-add',
        clientRequestId: customRequest.clientRequestId,
        clientMessageId: customRequest.clientMessageId,
        chatId: customRequest.chatId,
        transcriptViewId: customRequest.transcriptViewId,
        ordinal: 4,
        presentation: {
          style: 'custom',
          customStyle: {
            darkAccent: '#c4b5fd',
            lightAccent: '#7c3aed',
          },
        },
        format: customRequest.format,
        disclosure: customRequest.disclosure,
        status: 'appended',
        timestamp: '2026-08-23T00:00:00.000Z',
      }),
    });

    await expect(client.addChatRow(customRequest)).resolves.toMatchObject({
      ordinal: 4,
      presentation: customRequest.presentation,
    });
  });

  test('retries an ambiguous mutation with the byte-identical request body', async () => {
    const bodies: string[] = [];
    let postAttempts = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes('/api/v1/runtime?')) return runtimeResponse(input);
        bodies.push(String(init?.body));
        postAttempts += 1;
        if (postAttempts === 1) throw new TypeError('connection reset');
        return Response.json({
          success: true,
          commandType: 'chat-row-add',
          ...addRequest,
          ordinal: 3,
          status: 'duplicate',
          timestamp: '2026-08-18T00:00:00.000Z',
        });
      },
    });

    await expect(client.addChatRow(addRequest)).resolves.toMatchObject({ status: 'duplicate' });
    expect(bodies).toEqual([JSON.stringify(addRequest), JSON.stringify(addRequest)]);
  });

  test('does not retry or refresh a definitive stale-view response', async () => {
    let calls = 0;
    const client = new GarconClient({
      ...connection,
      submissionDelay: async () => undefined,
      fetch: async () => {
        calls += 1;
        return Response.json({
          success: false,
          error: 'The transcript changed before the row was added.',
          errorCode: 'STALE_TRANSCRIPT_VIEW',
          retryable: false,
        }, { status: 409 });
      },
    });

    await expect(client.addChatRow(addRequest)).rejects.toMatchObject({
      errorCode: 'STALE_TRANSCRIPT_VIEW',
    });
    expect(calls).toBe(1);
  });
});
