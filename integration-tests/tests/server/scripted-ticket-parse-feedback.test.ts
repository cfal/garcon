import { describe, expect, test } from 'bun:test';
import { escapeGarconXmlText } from '../../../common/garcon-command-envelope.js';
import { parseGarconCommandRejection } from '../../../common/garcon-command-rejection.js';
import { parseGarconTicketResult } from '../../../common/garcon-ticket-result.js';
import { parseTicketDetail, parseTicketPage } from '../../../common/ticket-responses.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import { withTimeout } from '../../support/deferred.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

async function environmentFor(agent: 'claude' | 'codex') {
  if (agent === 'codex') {
    const environment = await startScriptedCodexTestEnvironment();
    return { fixtureOptions: environment, startRequest: liveCodexStartRequest,
      script: (reply: (input: string) => Promise<string>) => environment.model.scriptTurn(async (request) => [codexAssistantMessage(await reply(request.lastUserText))]),
      settled: () => environment.model.assertSettled(), dispose: () => environment.dispose() };
  }
  const environment = await startScriptedClaudeTestEnvironment();
  return { fixtureOptions: environment, startRequest: liveClaudeStartRequest,
    script: (reply: (input: string) => Promise<string>) => environment.model.scriptTurn(async (request) => [claudeText(await reply(request.lastUserText))]),
    settled: () => environment.model.assertSettled(), dispose: () => environment.dispose() };
}

function controlEnvelope(input: string, opener: string): string {
  // Providers may prepend their own steering guidance to the control content.
  const start = input.indexOf(opener);
  expect(start).toBeGreaterThanOrEqual(0);
  return input.slice(start);
}

describe('scripted ticket parse feedback', () => {
  for (const agent of ['claude', 'codex'] as const) {
    test(`${agent} samples rejection feedback and explicitly repairs a create through its real binary`, async () => {
      const environment = await environmentFor(agent);
      const acknowledged = Promise.withResolvers<string>();
      const release = Promise.withResolvers<void>();
      try {
        await withIntegrationFixture(`${agent}-ticket-parse-feedback`, async (fixture) => {
          const chatId = fixture.newChatId();
          const description = 'Synthetic <T> && Record<string, unknown>.';
          const body = JSON.stringify({ title: 'Synthetic repaired ticket', description, project: 'Synthetic project' });
          const markup = (value: string) => `<garcon-ticket-create ref="repair">${value}</garcon-ticket-create>`;
          environment.script(async () => markup(body));
          environment.script(async (input) => {
            const rejection = parseGarconCommandRejection(controlEnvelope(input, '<garcon-command-rejected>'));
            if (!rejection) throw new Error('Real provider did not receive parse feedback');
            expect(rejection.issues).toEqual([{ command: 'ticket-create', reason: 'malformed', edge: 'leading' }]);
            expect(rejection.message).toContain('serialize the JSON first');
            expect(parseTicketPage(await fixture.client.get('/api/v1/tickets')).items).toEqual([]);
            return markup(escapeGarconXmlText(body));
          });
          environment.script(async (input) => {
            acknowledged.resolve(input);
            await release.promise;
            return 'Synthetic repair acknowledged.';
          });
          const start = environment.startRequest({ chatId, projectPath: fixture.dirs.project, command: 'Create a synthetic ticket.' });
          await fixture.client.startChat(start);
          const resultInput = await withTimeout(acknowledged.promise, 60_000, () => 'No repaired ticket result reached the real provider');
          const result = parseGarconTicketResult(controlEnvelope(resultInput, '<garcon-ticket-create-result '));
          expect(result).toMatchObject({ command: 'create', status: 'ok', ref: 'repair' });
          if (!result || result.status !== 'ok' || result.command !== 'create') throw new Error('Missing create receipt');
          expect(parseTicketPage(await fixture.client.get('/api/v1/tickets')).items).toHaveLength(1);
          expect(parseTicketDetail(await fixture.client.get(`/api/v1/tickets/detail?ticketId=${result.ticketId}`)).ticket.description).toBe(description);
          const cursor = fixture.client.markEvents();
          release.resolve();
          expect((await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor, timeoutMs: 60_000 })).type).toBe('agent-run-finished');
          const transcript = await fixture.client.getMessages(chatId);
          expect(userContents(transcript.messages)).toEqual([start.command]);
          expect(messagesOfType(transcript.messages, 'transcript-notice').filter((notice) => notice.content === 'Garcon could not parse a ticket-create command.')).toHaveLength(1);
          expect(messagesOfType(transcript.messages, 'assistant-message').map((message) => message.content)).toContain(markup(body));
          environment.settled();
        }, environment.fixtureOptions);
      } finally {
        release.resolve();
        await environment.dispose();
      }
    }, 120_000);
  }
});
