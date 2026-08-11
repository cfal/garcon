import { describe, expect, it, mock } from 'bun:test';
import { compositeSearchContentEpoch, TranscriptSearchController } from '../controller.js';

const emptyStatus = {
  indexedChatCount: 0,
  pendingChatCount: 0,
  failedChatCount: 0,
  unsupportedChatCount: 0,
};

function registration(agentId, chatId) {
  return {
    agentId,
    reference: {
      chatId,
      projectPath: '/repo',
      model: 'model',
      nativeSession: null,
      carryOverRevision: 'carry-v1:0',
      agentOwnershipEpoch: `owner-${chatId}`,
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
    transcriptContentEpoch: `segment-${chatId}`,
  };
}

function source(agentId, chatId) {
  return {
    apiVersion: 2,
    ownerId: agentId,
    schemaVersion: 2,
    checkpoint: {
      chatId,
      agentOwnershipEpoch: `owner-${chatId}`,
      contentEpoch: `segment-${chatId}`,
      durableCount: 0,
      durableRevision: 'revision-empty',
    },
    value: { directory: '/tmp/projection' },
  };
}

function compositeEpoch(chatId) {
  return compositeSearchContentEpoch({
    carryOverRevision: 'carry-v1:0',
    agentOwnershipEpoch: `owner-${chatId}`,
    segmentContentEpoch: `segment-${chatId}`,
  });
}

function integration(agentId, source = null) {
  return {
    descriptor: { id: agentId },
    transcript: {
      resolveIndexSource: mock(async () => ({ kind: 'ready', value: source })),
      refreshIndexSource: mock(async () => ({ kind: 'ready', value: source })),
    },
  };
}

function createService(overrides = {}) {
  return {
    operationEpoch: () => 'operation-epoch',
    setSourceRefreshHandler: mock(() => {}),
    setCatalogRefreshHandler: mock(() => {}),
    enable: mock(async () => {}),
    reconcile: mock(async () => {}),
    sourceMayHaveChanged: mock(() => {}),
    deleteChat: mock(() => {}),
    search: mock(async () => ({ results: [], index: emptyStatus })),
    disableAndDelete: mock(async () => {}),
    close: mock(async () => {}),
    ...overrides,
  };
}

function controllerFixture(integrations, registrations, service = createService()) {
  const byId = new Map(integrations.map((entry) => [entry.descriptor.id, entry]));
  const classes = integrations.map((entry) => ({
    integrationId: entry.descriptor.id,
    apiVersion: 4,
    transcriptIndex: { apiVersion: 2, moduleUrl: import.meta.url },
  }));
  return {
    controller: new TranscriptSearchController({
      integrations: {
        classes: () => classes,
        get: (agentId) => byId.get(agentId) ?? null,
      },
      listChats: () => registrations,
      service,
      persistContentEpoch: mock(async () => {}),
    }),
    service,
  };
}

describe('TranscriptSearchController', () => {
  it('cleans shared search storage while disabled', async () => {
    const { controller, service } = controllerFixture([], []);

    await controller.initialize(false);

    expect(service.disableAndDelete).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('awaits Worker admission but resolves sources in a background catalog build', async () => {
    let release;
    const blockedSource = new Promise((resolve) => { release = resolve; });
    const provider = integration('claude');
    provider.transcript.resolveIndexSource = mock(() => blockedSource);
    const { controller, service } = controllerFixture([provider], [registration('claude', 'chat-1')]);

    await controller.start();

    expect(service.enable).toHaveBeenCalledWith({
      modules: [{
        agentId: 'claude',
        reference: { apiVersion: 2, moduleUrl: import.meta.url },
      }],
      signal: expect.any(AbortSignal),
    });
    expect(service.reconcile).not.toHaveBeenCalled();
    release({
      kind: 'ready',
      value: source('claude', 'chat-1'),
    });
    await Bun.sleep(10);
    expect(service.reconcile).toHaveBeenCalledWith({
      generation: { epoch: 'operation-epoch', sequence: 1 },
      chats: [expect.objectContaining({
        chatId: 'chat-1',
        source: { state: 'ready', reference: expect.objectContaining({ ownerId: 'claude' }) },
      })],
    });
    await controller.close();
  });

  it('sends only a targeted payload-free dirty hint', async () => {
    const { controller, service } = controllerFixture(
      [integration('claude')],
      [registration('claude', 'chat-1')],
    );
    await controller.start();

    controller.sourceMayHaveChanged('chat-1');
    controller.sourceMayHaveChanged('missing');

    expect(service.sourceMayHaveChanged).toHaveBeenCalledTimes(1);
    expect(service.sourceMayHaveChanged).toHaveBeenCalledWith({
      chatId: 'chat-1',
      generation: { epoch: 'operation-epoch', sequence: 1 },
    });
    await controller.close();
  });

  it('forwards one global search and defensively filters its result', async () => {
    const service = createService({
      search: mock(async () => ({
        results: [
          { chatId: 'allowed', contentEpoch: compositeEpoch('allowed'), score: 2, matchedMessageCount: 1, snippets: [] },
          { chatId: 'stale', contentEpoch: 'superseded-content-epoch', score: 1.5, matchedMessageCount: 1, snippets: [] },
          { chatId: 'outside', contentEpoch: compositeEpoch('outside'), score: 1, matchedMessageCount: 1, snippets: [] },
        ],
        index: { ...emptyStatus, indexedChatCount: 1 },
      })),
    });
    const providers = [
      integration('claude', source('claude', 'allowed')),
      integration('pi', source('pi', 'stale')),
      integration('codex', source('codex', 'outside')),
    ];
    const { controller } = controllerFixture(
      providers,
      [
        registration('claude', 'allowed'),
        registration('pi', 'stale'),
        registration('codex', 'outside'),
      ],
      service,
    );
    await controller.start();
    await Bun.sleep(10);

    const response = await controller.search({
      query: 'needle',
      allowedChatIds: ['allowed', 'stale'],
    });

    expect(response.results.map((result) => result.chatId)).toEqual(['allowed']);
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({
      allowedChats: [
        { chatId: 'allowed', contentEpoch: compositeEpoch('allowed') },
        { chatId: 'stale', contentEpoch: compositeEpoch('stale') },
      ],
      limit: 20,
      query: expect.objectContaining({ version: 1 }),
    }));
    await controller.close();
  });

  it('deletes immediately and follows with a complete catalog', async () => {
    const { controller, service } = controllerFixture(
      [integration('claude')],
      [registration('claude', 'chat-1')],
    );
    await controller.start();

    controller.deleteChat('chat-1');

    expect(service.deleteChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      generation: { epoch: 'operation-epoch', sequence: 1 },
    });
    await controller.close();
  });

  it('caps concurrent source resolution per integration during the catalog sweep', async () => {
    const inFlight = new Map();
    const peaks = new Map();
    const provider = (agentId) => {
      const entry = integration(agentId);
      entry.transcript.resolveIndexSource = mock(async ({ chat }) => {
        inFlight.set(agentId, (inFlight.get(agentId) ?? 0) + 1);
        peaks.set(agentId, Math.max(peaks.get(agentId) ?? 0, inFlight.get(agentId)));
        await Bun.sleep(10);
        inFlight.set(agentId, inFlight.get(agentId) - 1);
        return { kind: 'ready', value: source(agentId, chat.chatId) };
      });
      return entry;
    };
    const registrations = ['claude', 'codex'].flatMap((agentId) => (
      Array.from({ length: 6 }, (_, index) => registration(agentId, `${agentId}-${index}`))
    ));
    const { controller, service } = controllerFixture(
      [provider('claude'), provider('codex')],
      registrations,
    );

    await controller.start();
    while (service.reconcile.mock.calls.length === 0) await Bun.sleep(5);

    expect(peaks.get('claude')).toBeLessThanOrEqual(2);
    expect(peaks.get('codex')).toBeLessThanOrEqual(2);
    expect(service.reconcile.mock.calls[0][0].chats).toHaveLength(12);
    await controller.close();
  });

  it('reports failed admission as retryable and permits a later retry', async () => {
    const service = createService();
    service.enable.mockImplementationOnce(async () => {
      throw new Error('reader unavailable');
    });
    const { controller } = controllerFixture([], [], service);

    await expect(controller.start()).rejects.toThrow('reader unavailable');
    await expect(controller.search({ query: 'needle', allowedChatIds: [] }))
      .rejects.toMatchObject({
        code: 'SEARCH_INDEX_UNAVAILABLE',
        retryable: true,
      });
    await controller.start();

    expect(service.enable).toHaveBeenCalledTimes(2);
    await controller.close();
  });
});
