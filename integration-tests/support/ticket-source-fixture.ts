import { expect } from 'bun:test';
import { parseGarconTicketResult } from '../../common/garcon-ticket-result.js';
import { parseTicketHistoryPage } from '../../common/ticket-responses.js';
import { parseTicketSourceResolution } from '../../common/ticket-source-navigation.js';
import type { TicketSource } from '../../common/tickets.js';
import type { AddChatRowRequest } from '../../common/chat-row-contracts.js';
import type { IntegrationFixture } from './integration-fixture.js';

export function resolveTicketSource(fixture: IntegrationFixture, source: TicketSource) {
  const query = new URLSearchParams({ chatId: source.chatId,
    transcriptViewId: source.transcriptViewId, ordinal: String(source.ordinal) });
  return fixture.client.get(`/api/v1/chats/ticket-source?${query}`).then(parseTicketSourceResolution);
}

export async function createTicketSource(fixture: IntegrationFixture, laterRows = 0) {
  const chatId = fixture.newChatId();
  const content = 'Synthetic source navigation instruction.';
  const initial = fixture.fakeProviders.openAi.holdNext({ lastUserText: content });
  const acknowledgment = fixture.fakeProviders.openAi.holdNext({});
  const turn = await fixture.client.startDirectChat({ chatId, content,
    projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi });
  await initial.received;
  initial.releaseText('<garcon-ticket-create ref="synthetic-source">{"title":"Synthetic source ticket","project":"Release"}</garcon-ticket-create>');
  await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
  const request = await acknowledgment.received;
  const result = parseGarconTicketResult(request.lastUserText);
  if (!result || result.status !== 'ok' || !('revision' in result.data)) {
    throw new Error('Missing synthetic ticket mutation receipt');
  }
  const cursor = fixture.client.markEvents();
  acknowledgment.releaseText('Synthetic source acknowledgment.');
  expect((await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor })).type).toBe('agent-run-finished');
  const ticketId = result.data.ticketId;
  const history = parseTicketHistoryPage(await fixture.client.get(`/api/v1/tickets/history?ticketId=${ticketId}`));
  const source = history.items[0]?.source;
  if (!source) throw new Error('Missing synthetic ticket source');
  const resolution = await resolveTicketSource(fixture, source);
  if (resolution.kind !== 'found') throw new Error('Missing synthetic visible outcome');
  for (let index = 0; index < laterRows; index++) {
    await fixture.client.post('/api/v1/chats/rows', {
      clientRequestId: `synthetic-source-row-request-${index}`,
      clientMessageId: `synthetic-source-row-message-${index}`,
      chatId, transcriptViewId: source.transcriptViewId,
      presentation: { style: 'notice' }, format: 'plain', disclosure: 'expanded',
      content: `Synthetic later row ${index}.`,
    } satisfies AddChatRowRequest);
  }
  return { chatId, ticketId, source, target: resolution.target };
}
