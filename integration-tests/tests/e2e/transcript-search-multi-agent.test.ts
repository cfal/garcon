import { describe, expect, test } from 'bun:test';
import type { ConfiguredDirectTestAgent } from '../../support/garcon-client.js';
import type { IntegrationFixture } from '../../support/integration-fixture.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

function marker(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '')}`;
}

async function createSearchableChat(input: {
  fixture: IntegrationFixture;
  chatId: string;
  agent: ConfiguredDirectTestAgent;
  seed: string;
  middle: string;
  tail: string;
}): Promise<void> {
  const turns = [input.seed, input.middle, input.tail];
  const first = await input.fixture.client.startDirectChat({
    chatId: input.chatId,
    content: turns[0],
    projectPath: input.fixture.dirs.project,
    agent: input.agent,
  });
  expect((await input.fixture.client.waitForTurnTerminal(input.chatId, first.turnId)).type).toBe(
    'agent-run-finished',
  );
  for (const content of turns.slice(1)) {
    const accepted = await input.fixture.client.runDirectChat({
      chatId: input.chatId,
      content,
      agent: input.agent,
    });
    expect((await input.fixture.client.waitForTurnTerminal(input.chatId, accepted.turnId)).type)
      .toBe('agent-run-finished');
  }
}

describe('Lightpanda multi-agent transcript search', () => {
  test('renders only the chat containing a unique middle-turn transcript marker', async () => {
    await withE2eFixture('transcript-search-multi-agent', async (fixture) => {
      const openAiChatId = fixture.integration.newChatId();
      const anthropicChatId = fixture.integration.newChatId();
      const controlChatId = fixture.integration.newChatId();
      const anthropicOnly = marker('uianthropiconly');
      const anthropicSeed = marker('uianthropicseed');
      const controlSeed = marker('uicontrolseed');

      await createSearchableChat({
        fixture: fixture.integration,
        chatId: openAiChatId,
        agent: fixture.integration.directAgents.openAi,
        seed: marker('uiopenaiseed'),
        middle: marker('uiopenaimiddle'),
        tail: marker('uiopenaitail'),
      });
      await createSearchableChat({
        fixture: fixture.integration,
        chatId: anthropicChatId,
        agent: fixture.integration.directAgents.anthropic,
        seed: anthropicSeed,
        middle: anthropicOnly,
        tail: marker('uianthropictail'),
      });
      await createSearchableChat({
        fixture: fixture.integration,
        chatId: controlChatId,
        agent: fixture.integration.directAgents.openAi,
        seed: controlSeed,
        middle: marker('uicontrolmiddle'),
        tail: marker('uicontroltail'),
      });
      await fixture.integration.client.updateSettings({
        features: { transcriptSearch: { enabled: true } },
      });
      const chatIds = [openAiChatId, anthropicChatId, controlChatId];
      await fixture.integration.client.waitForChatSearch(
        { query: anthropicOnly, chatIds },
        (response) => response.index.pendingChatCount === 0
          && response.results.length === 1
          && response.results[0]?.chatId === anthropicChatId,
      );

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.openChatSearch();
      await app.searchChats(anthropicOnly);
      await app.waitForTranscriptSearchResult({ count: 1, snippet: anthropicOnly });

      expect(await app.chatSearchResultCount()).toBe(1);
      const resultsText = await app.chatSearchResultsText();
      expect(resultsText).toContain(anthropicOnly);
      expect(resultsText).toContain('Direct (Anthropic)');
      expect(resultsText).toContain(anthropicSeed);
      expect(resultsText).not.toContain(controlSeed);
      fixture.assertNoBrowserErrors();
    });
  });
});
