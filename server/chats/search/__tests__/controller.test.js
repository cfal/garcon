import { describe, expect, it, mock } from 'bun:test';
import { TranscriptSearchController } from '../controller.js';

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
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function integration(agentId, source = null) {
  return {
    descriptor: { id: agentId },
    transcript: {
      resolveIndexSource: mock(async () => source),
      refreshIndexSource: mock(async () => source),
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
    apiVersion: 2,
    transcriptIndex: { apiVersion: 1, moduleUrl: import.meta.url },
  }));
  return {
    controller: new TranscriptSearchController({
      integrations: {
        classes: () => classes,
        get: (agentId) => byId.get(agentId) ?? null,
      },
      listChats: () => registrations,
      service,
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
        reference: { apiVersion: 1, moduleUrl: import.meta.url },
      }],
      signal: expect.any(AbortSignal),
    });
    expect(service.reconcile).not.toHaveBeenCalled();
    release({ ownerId: 'claude', schemaVersion: 1, value: { nativePath: '/tmp/chat.jsonl' } });
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
          { chatId: 'allowed', score: 2, matchedMessageCount: 1, snippets: [] },
          { chatId: 'outside', score: 1, matchedMessageCount: 1, snippets: [] },
        ],
        index: { ...emptyStatus, indexedChatCount: 1 },
      })),
    });
    const { controller } = controllerFixture([], [], service);
    await controller.start();

    const response = await controller.search({ query: 'needle', allowedChatIds: ['allowed'] });

    expect(response.results.map((result) => result.chatId)).toEqual(['allowed']);
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({
      allowedChatIds: ['allowed'],
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
