import { expect } from 'bun:test';
import type { AddChatRowRequest } from '../../common/chat-row-contracts.js';
import type { IntegrationFixture } from './integration-fixture.js';

export async function createSearchNavigationTarget(
  fixture: IntegrationFixture,
  marker = 'syntheticsearchanchor',
) {
  const chatId = fixture.newChatId();
  const content = 'Synthetic search navigation instruction.';
  const response = fixture.fakeProviders.openAi.holdNext({
    lastUserText: content,
  });
  const turn = await fixture.client.startDirectChat({
    chatId,
    content,
    projectPath: fixture.dirs.project,
    agent: fixture.directAgents.openAi,
  });
  await response.received;
  response.releaseText(`Synthetic matching response ${marker}.`);
  expect((await fixture.client.waitForTurnTerminal(chatId, turn.turnId)).type).toBe(
    'agent-run-finished',
  );
  await fixture.client.updateSettings({
    features: { transcriptSearch: { enabled: true } },
  });
  const found = await fixture.client.waitForChatSearch(
    { query: marker, chatIds: [chatId] },
    (result) => result.results[0]?.snippets.length === 1,
  );
  const result = found.results[0]!;
  const target = {
    chatId,
    transcriptViewId: result.transcriptViewId,
    ordinal: result.snippets[0]!.ordinal,
  };
  for (let index = 0; index < 110; index++) {
    await fixture.client.post('/api/v1/chats/rows', {
      clientRequestId: `synthetic-search-request-${index}`,
      clientMessageId: `synthetic-search-message-${index}`,
      chatId,
      transcriptViewId: target.transcriptViewId,
      presentation: { style: 'notice' },
      format: 'plain',
      disclosure: 'expanded',
      content: `Synthetic later row ${index}.`,
    } satisfies AddChatRowRequest);
  }
  return { chatId, target, marker };
}
