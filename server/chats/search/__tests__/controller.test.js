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

function integration(agentId, search) {
  return {
    descriptor: { id: agentId },
    transcript: { revision: mock(async ({ chat }) => `revision:${chat.chatId}`) },
    transcriptSearch: {
      reconcile: mock(async () => undefined),
      search,
      disableAndDelete: mock(async () => undefined),
    },
  };
}

function controllerFixture(integrations, registrations) {
  const byId = new Map(integrations.map((entry) => [entry.descriptor.id, entry]));
  return new TranscriptSearchController({
    integrations: {
      list: () => integrations,
      get: (agentId) => byId.get(agentId) ?? null,
      require: (agentId) => {
        const found = byId.get(agentId);
        if (!found) throw new Error(`Missing integration: ${agentId}`);
        return found;
      },
    },
    listChats: () => registrations,
  });
}

function hit(chatId) {
  return { chatId, matchedMessageCount: 1, snippets: [] };
}

describe('TranscriptSearchController', () => {
  it('retries integration-owned cleanup on startup while search is disabled', async () => {
    const disableAndDelete = mock(async () => {});
    const controller = new TranscriptSearchController({
      integrations: {
        list: () => [{ transcriptSearch: { disableAndDelete } }],
      },
      listChats: () => [],
    });

    await controller.initialize(false);

    expect(disableAndDelete).toHaveBeenCalledWith({
      generation: { epoch: expect.any(String), sequence: 1 },
      signal: expect.any(AbortSignal),
    });
  });

  it('partitions allowed chats by agent and returns only the actual integration hit', async () => {
    const openAiSearch = mock(async () => ({
      hits: [],
      index: { ...emptyStatus, indexedChatCount: 2 },
    }));
    const anthropicSearch = mock(async () => ({
      hits: [hit('anthropic-chat')],
      index: { ...emptyStatus, indexedChatCount: 1 },
    }));
    const controller = controllerFixture([
      integration('direct-openai-compatible', openAiSearch),
      integration('direct-anthropic-compatible', anthropicSearch),
    ], [
      registration('direct-openai-compatible', 'openai-chat'),
      registration('direct-openai-compatible', 'control-chat'),
      registration('direct-anthropic-compatible', 'anthropic-chat'),
    ]);
    await controller.start();

    const response = await controller.search({
      query: 'anthropiconly',
      allowedChatIds: ['openai-chat', 'anthropic-chat', 'control-chat'],
      limit: 20,
    });

    expect(response.results.map((result) => result.chatId)).toEqual(['anthropic-chat']);
    expect(response.index.indexedChatCount).toBe(3);
    expect(openAiSearch).toHaveBeenCalledWith(expect.objectContaining({
      chats: [
        expect.objectContaining({ chatId: 'control-chat' }),
        expect.objectContaining({ chatId: 'openai-chat' }),
      ],
    }));
    expect(anthropicSearch).toHaveBeenCalledWith(expect.objectContaining({
      chats: [expect.objectContaining({ chatId: 'anthropic-chat' })],
    }));
    await controller.close();
  });

  it('interleaves ranks deterministically and deduplicates defensive duplicate hits', async () => {
    const anthropicSearch = mock(async () => ({
      hits: [hit('shared'), hit('anthropic-two')],
      index: { ...emptyStatus, indexedChatCount: 2 },
    }));
    const openAiSearch = mock(async () => ({
      hits: [hit('shared'), hit('openai-two')],
      index: { ...emptyStatus, indexedChatCount: 2 },
    }));
    const controller = controllerFixture([
      integration('direct-openai-compatible', openAiSearch),
      integration('direct-anthropic-compatible', anthropicSearch),
    ], [
      registration('direct-anthropic-compatible', 'shared'),
      registration('direct-anthropic-compatible', 'anthropic-two'),
      registration('direct-openai-compatible', 'shared'),
      registration('direct-openai-compatible', 'openai-two'),
    ]);
    await controller.start();

    const response = await controller.search({
      query: 'shared',
      allowedChatIds: ['shared', 'anthropic-two', 'openai-two'],
    });

    expect(response.results.map((result) => result.chatId)).toEqual([
      'shared',
      'anthropic-two',
      'openai-two',
    ]);
    expect(response.results.map((result) => result.score)).toEqual([1, 0.5, 1 / 3]);
    await controller.close();
  });

  it('rejects an integration hit outside its eligible scope', async () => {
    const search = mock(async () => ({
      hits: [hit('not-allowed')],
      index: { ...emptyStatus, indexedChatCount: 1 },
    }));
    const controller = controllerFixture([
      integration('direct-anthropic-compatible', search),
    ], [registration('direct-anthropic-compatible', 'anthropic-chat')]);
    await controller.start();

    const response = await controller.search({
      query: 'needle',
      allowedChatIds: ['anthropic-chat'],
    });

    expect(response.results).toEqual([]);
    expect(response.index).toEqual(emptyStatus);
    expect(response.partialFailures).toEqual([{
      agentId: 'direct-anthropic-compatible',
      code: 'INVALID_RESPONSE',
      retryable: false,
      eligibleChatCount: 1,
    }]);
    await controller.close();
  });

  it('preserves successful results and status when another integration fails', async () => {
    const openAiSearch = mock(async () => ({
      hits: [hit('openai-chat')],
      index: {
        indexedChatCount: 1,
        pendingChatCount: 0,
        failedChatCount: 1,
        unsupportedChatCount: 0,
      },
    }));
    const anthropicSearch = mock(async () => {
      throw Object.assign(new Error('index unavailable'), { retryable: true });
    });
    const controller = controllerFixture([
      integration('direct-openai-compatible', openAiSearch),
      integration('direct-anthropic-compatible', anthropicSearch),
    ], [
      registration('direct-openai-compatible', 'openai-chat'),
      registration('direct-anthropic-compatible', 'anthropic-chat'),
    ]);
    await controller.start();

    const response = await controller.search({
      query: 'needle',
      allowedChatIds: ['openai-chat', 'anthropic-chat'],
    });

    expect(response.results.map((result) => result.chatId)).toEqual(['openai-chat']);
    expect(response.index).toEqual({
      indexedChatCount: 1,
      pendingChatCount: 0,
      failedChatCount: 1,
      unsupportedChatCount: 0,
    });
    expect(response.partialFailures).toEqual([{
      agentId: 'direct-anthropic-compatible',
      code: 'SEARCH_UNAVAILABLE',
      retryable: true,
      eligibleChatCount: 1,
    }]);
    await controller.close();
  });
});
