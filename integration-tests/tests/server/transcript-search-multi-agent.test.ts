import { describe, expect, test } from 'bun:test';
import type { ConfiguredDirectTestAgent } from '../../support/garcon-client.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

function marker(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '')}`;
}

async function completeSearchableChat(input: {
  fixture: IntegrationFixture;
  chatId: string;
  agent: ConfiguredDirectTestAgent;
  seed: string;
  middle: string;
  tail: string;
}): Promise<void> {
  const first = await input.fixture.client.startDirectChat({
    chatId: input.chatId,
    content: input.seed,
    projectPath: input.fixture.dirs.project,
    agent: input.agent,
  });
  expect((await input.fixture.client.waitForTurnTerminal(input.chatId, first.turnId)).type).toBe(
    'agent-run-finished',
  );
  const second = await input.fixture.client.runDirectChat({
    chatId: input.chatId,
    content: input.middle,
    agent: input.agent,
  });
  expect((await input.fixture.client.waitForTurnTerminal(input.chatId, second.turnId)).type).toBe(
    'agent-run-finished',
  );
  const third = await input.fixture.client.runDirectChat({
    chatId: input.chatId,
    content: input.tail,
    agent: input.agent,
  });
  expect((await input.fixture.client.waitForTurnTerminal(input.chatId, third.turnId)).type).toBe(
    'agent-run-finished',
  );
}

async function enableTranscriptSearch(fixture: IntegrationFixture): Promise<void> {
  const updated = await fixture.client.updateSettings({
    features: { transcriptSearch: { enabled: true } },
  });
  expect(updated.settings.features.transcriptSearch.enabled).toBe(true);
}

describe('multi-agent transcript search', () => {
  test('returns only actual transcript matches across agent-owned sources', async () => {
    await withIntegrationFixture('transcript-search-multi-agent-results', async (fixture) => {
      const openAiChatId = fixture.newChatId();
      const anthropicChatId = fixture.newChatId();
      const controlChatId = fixture.newChatId();
      const openAiOnly = marker('openaionly');
      const anthropicOnly = marker('anthropiconly');
      const shared = marker('sharedmarker');

      await completeSearchableChat({
        fixture,
        chatId: openAiChatId,
        agent: fixture.directAgents.openAi,
        seed: marker('openaiseed'),
        middle: `${openAiOnly} ${shared}`,
        tail: marker('openaitail'),
      });
      await completeSearchableChat({
        fixture,
        chatId: anthropicChatId,
        agent: fixture.directAgents.anthropic,
        seed: marker('anthropicseed'),
        middle: `${anthropicOnly} ${shared}`,
        tail: marker('anthropictail'),
      });
      await completeSearchableChat({
        fixture,
        chatId: controlChatId,
        agent: fixture.directAgents.openAi,
        seed: marker('controlseed'),
        middle: marker('controlmiddle'),
        tail: marker('controltail'),
      });
      await enableTranscriptSearch(fixture);

      const chatIds = [openAiChatId, anthropicChatId, controlChatId];
      const anthropicResult = await fixture.client.waitForChatSearch(
        { query: anthropicOnly, chatIds, limit: 20 },
        (response) => response.index.pendingChatCount === 0
          && response.results.map((result) => result.chatId).join(',') === anthropicChatId,
      );
      expect(anthropicResult.results.map((result) => result.chatId)).toEqual([anthropicChatId]);
      expect(anthropicResult.index.indexedChatCount).toBe(3);

      const openAiResult = await fixture.client.waitForChatSearch(
        { query: openAiOnly, chatIds, limit: 20 },
        (response) => response.index.pendingChatCount === 0
          && response.results.map((result) => result.chatId).join(',') === openAiChatId,
      );
      expect(openAiResult.results.map((result) => result.chatId)).toEqual([openAiChatId]);

      const sharedResult = await fixture.client.waitForChatSearch(
        { query: shared, chatIds, limit: 20 },
        (response) => response.index.pendingChatCount === 0 && response.results.length === 2,
      );
      expect(sharedResult.results.map((result) => result.chatId)).toEqual([
        anthropicChatId,
        openAiChatId,
      ]);
      expect(new Set(sharedResult.results.map((result) => result.chatId)).size).toBe(2);
      expect(sharedResult.results.map((result) => result.chatId)).not.toContain(controlChatId);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(6);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(3);
    });
  });

  test('preserves and prunes multi-agent search across restart and deletion', async () => {
    await withIntegrationFixture('transcript-search-multi-agent-restart-delete', async (fixture) => {
      const openAiChatId = fixture.newChatId();
      const anthropicChatId = fixture.newChatId();
      const openAiOnly = marker('restartopenai');
      const anthropicOnly = marker('restartanthropic');
      await completeSearchableChat({
        fixture,
        chatId: openAiChatId,
        agent: fixture.directAgents.openAi,
        seed: marker('restartopenaiseed'),
        middle: openAiOnly,
        tail: marker('restartopenaitail'),
      });
      await completeSearchableChat({
        fixture,
        chatId: anthropicChatId,
        agent: fixture.directAgents.anthropic,
        seed: marker('restartanthropicseed'),
        middle: anthropicOnly,
        tail: marker('restartanthropictail'),
      });
      await enableTranscriptSearch(fixture);
      const chatIds = [openAiChatId, anthropicChatId];
      await fixture.client.waitForChatSearch(
        { query: anthropicOnly, chatIds },
        (response) => response.index.pendingChatCount === 0
          && response.results.some((result) => result.chatId === anthropicChatId),
      );
      const openAiRequestCount = fixture.fakeProviders.openAi.requests().length;
      const anthropicRequestCount = fixture.fakeProviders.anthropic.requests().length;

      await fixture.restartGarcon();
      const afterRestartAnthropic = await fixture.client.waitForChatSearch(
        { query: anthropicOnly, chatIds },
        (response) => response.index.pendingChatCount === 0,
      );
      const afterRestartOpenAi = await fixture.client.waitForChatSearch(
        { query: openAiOnly, chatIds },
        (response) => response.index.pendingChatCount === 0,
      );
      expect(afterRestartAnthropic.results.map((result) => result.chatId)).toEqual([
        anthropicChatId,
      ]);
      expect(afterRestartOpenAi.results.map((result) => result.chatId)).toEqual([openAiChatId]);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(openAiRequestCount);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(anthropicRequestCount);

      await fixture.client.deleteChat(anthropicChatId);
      const pruned = await fixture.client.waitForChatSearch(
        { query: anthropicOnly, chatIds },
        (response) => response.index.pendingChatCount === 0
          && response.results.every((result) => result.chatId !== anthropicChatId),
      );
      expect(pruned.results).toEqual([]);
      expect(pruned.index.indexedChatCount).toBe(1);
      const retained = await fixture.client.waitForChatSearch(
        { query: openAiOnly, chatIds },
        (response) => response.index.pendingChatCount === 0,
      );
      expect(retained.results.map((result) => result.chatId)).toEqual([openAiChatId]);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(openAiRequestCount);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(anthropicRequestCount);
    });
  });
});
