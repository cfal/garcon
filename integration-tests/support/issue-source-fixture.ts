import { expect } from 'bun:test';
import { parseGarconIssueResult } from '../../common/garcon-issue-result.js';
import { parseIssueHistoryPage } from '../../common/issue-responses.js';
import { parseIssueSourceResolution } from '../../common/issue-source-navigation.js';
import type { IssueSource } from '../../common/issues.js';
import type { AddChatRowRequest } from '../../common/chat-row-contracts.js';
import type { IntegrationFixture } from './integration-fixture.js';

export function resolveIssueSource(fixture: IntegrationFixture, source: IssueSource) {
  const query = new URLSearchParams({ chatId: source.chatId,
    transcriptViewId: source.transcriptViewId, ordinal: String(source.ordinal) });
  return fixture.client.get(`/api/v1/chats/issue-source?${query}`).then(parseIssueSourceResolution);
}

export async function createIssueSource(fixture: IntegrationFixture, laterRows = 0) {
  const chatId = fixture.newChatId();
  const content = 'Synthetic source navigation instruction.';
  const initial = fixture.fakeProviders.openAi.holdNext({ lastUserText: content });
  const acknowledgment = fixture.fakeProviders.openAi.holdNext({});
  const turn = await fixture.client.startDirectChat({ chatId, content,
    projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi });
  await initial.received;
  initial.releaseText('<garcon-issue-create ref="synthetic-source">{"title":"Synthetic source issue","project":"Release"}</garcon-issue-create>');
  await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
  const request = await acknowledgment.received;
  const result = parseGarconIssueResult(request.lastUserText);
  if (!result || result.status !== 'ok' || !('revision' in result.data)) {
    throw new Error('Missing synthetic issue mutation receipt');
  }
  const cursor = fixture.client.markEvents();
  acknowledgment.releaseText('Synthetic source acknowledgment.');
  expect((await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor })).type).toBe('agent-run-finished');
  const issueId = result.data.issueId;
  const history = parseIssueHistoryPage(await fixture.client.get(`/api/v1/issues/history?issueId=${issueId}`));
  const source = history.items[0]?.source;
  if (!source) throw new Error('Missing synthetic issue source');
  const resolution = await resolveIssueSource(fixture, source);
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
  return { chatId, issueId, source, target: resolution.target };
}
