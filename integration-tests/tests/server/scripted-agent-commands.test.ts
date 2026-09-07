import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StartChatCommandRequest } from '../../../common/chat-command-contracts.js';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { escapeGarconXmlText } from '../../../common/garcon-command-envelope.js';
import { garconCommandResultContent } from '../../../common/garcon-command-results.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { chatCompletionsText, chatCompletionsToolUse } from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture, type IntegrationFixtureOptions } from '../../support/integration-fixture.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { startScriptedPiTestEnvironment, scriptedPiStartRequest } from '../../support/scripted-pi.js';
import { startScriptedOpenCodeTestEnvironment, scriptedOpenCodeStartRequest, openCodeNativeSession, readOpenCodeSessionRows } from '../../support/scripted-opencode.js';

type StartInput = { chatId: string; projectPath: string; command: string };
interface ScriptedCommands {
  fixtureOptions: IntegrationFixtureOptions;
  startRequest(input: StartInput): StartChatCommandRequest;
  script(reply: (input: string) => string): void;
  settled(): void;
  dispose(): void | Promise<void>;
}

async function environmentFor(agent: string): Promise<ScriptedCommands> {
  if (agent === 'codex') {
    const environment = await startScriptedCodexTestEnvironment();
    return { fixtureOptions: environment, startRequest: liveCodexStartRequest,
      script: (reply) => environment.model.scriptTurn((request) => [codexAssistantMessage(reply(request.lastUserText))]),
      settled: () => environment.model.assertSettled(), dispose: () => environment.dispose() };
  }
  if (agent === 'claude') {
    const environment = await startScriptedClaudeTestEnvironment();
    return { fixtureOptions: environment, startRequest: liveClaudeStartRequest,
      script: (reply) => environment.model.scriptTurn((request) => [claudeText(reply(request.lastUserText))]),
      settled: () => environment.model.assertSettled(), dispose: () => environment.dispose() };
  }
  const environment = startScriptedPiTestEnvironment();
  return { fixtureOptions: environment, startRequest: scriptedPiStartRequest,
    script: (reply) => environment.model.scriptTurn((request) => [chatCompletionsText(reply(request.lastUserText))]),
    settled: () => environment.model.assertSettled(), dispose: () => environment.dispose() };
}

describe('scripted provider agent commands', () => {
  for (const [agent, createsChild] of [['claude', true], ['codex', true], ['claude', false], ['codex', false], ['pi', false]] as const) {
    test(`${agent} accepts ${createsChild ? 'a child start' : 'a schedule'} and receives its private result through its real binary`, async () => {
      const environment = await environmentFor(agent);
      try {
        await withIntegrationFixture(`${agent}-scripted-agent-commands`, async (fixture) => {
          const source = fixture.newChatId();
          const start = environment.startRequest({ chatId: source, projectPath: fixture.dirs.project, command: 'Issue the synthetic command.' });
          const childPrompt = 'Independent synthetic child task.';
          const command = createsChild
            ? `<garcon-start-agent agent="${agent}" model="${escapeGarconXmlText(start.model)}" reasoning-effort="${start.thinkingMode}">${childPrompt}</garcon-start-agent>`
            : '<garcon-schedule every="5m" busy="skip" />';
          const received: string[] = [];
          environment.script(() => command);
          const reply = (input: string) => {
            received.push(input);
            return input.includes(childPrompt) ? 'Synthetic child complete.' : 'Synthetic result acknowledged.';
          };
          environment.script(reply);
          if (createsChild) environment.script(reply);
          const cursor = fixture.client.markEvents();
          await fixture.client.startChat(start);
          await fixture.client.waitForEvent(
            (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === source
              && event.messages.some(({ message }) => message.type === 'assistant-message' && message.content === 'Synthetic result acknowledged.'),
            'private action result acknowledged', { afterIndex: cursor, timeoutMs: 90_000 },
          );
          if (createsChild) {
            await fixture.client.waitForEvent(
              (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId !== source
                && event.messages.some(({ message }) => message.type === 'assistant-message' && message.content === 'Synthetic child complete.'),
              'independent child completed', { afterIndex: cursor, timeoutMs: 90_000 },
            );
          }
          const transcript = await fixture.client.getMessages(source);
          expect(userContents(transcript.messages)).toEqual([start.command]);
          const outcomes = messagesOfType(transcript.messages, 'transcript-notice').filter((notice) =>
            notice.detail?.type === (createsChild ? 'agent-start-outcome' : 'agent-schedule-outcome'));
          expect(outcomes).toHaveLength(1);
          expect(outcomes[0]!.detail).toMatchObject({ status: 'created' });
          const outcome = outcomes[0]!.detail;
          if (outcome?.type !== 'agent-start-outcome' && outcome?.type !== 'agent-schedule-outcome') throw new Error('Missing typed outcome');
          expect(received.some((input) => input.endsWith(garconCommandResultContent(outcome)))).toBe(true);
          expect(JSON.stringify(transcript.messages)).not.toContain('<garcon-start-agent');
          expect(JSON.stringify(transcript.messages)).not.toContain('<garcon-schedule');
          if (createsChild) {
            const chats = await fixture.client.listChats();
            const child = chats.sessions.find((chat) => chat.id !== source);
            expect(chats.sessions).toHaveLength(2);
            expect(child?.parentChat).toEqual({ chatId: source, relation: 'delegation' });
            expect(received.some((input) => input.endsWith(childPrompt))).toBe(true);
            expect(userContents((await fixture.client.getMessages(child!.id)).messages)).toEqual([childPrompt]);
          } else {
            expect((await fixture.client.getScheduledPrompts()).prompts).toMatchObject([{
              target: { type: 'existing-chat', chatId: source, busyBehavior: 'skip' },
              schedule: { intervalMinutes: 5 }, prompt: '<garcon-schedule-action />',
            }]);
          }
          environment.settled();
        }, environment.fixtureOptions);
      } finally { await environment.dispose(); }
    }, 120_000);
  }

  (process.platform === 'linux' ? test : test.skip)('opencode accepts a schedule and consumes its result at an active tool boundary', async () => {
    const environment = startScriptedOpenCodeTestEnvironment();
    let releasePath = '';
    environment.model.scriptTurn(() => [
      chatCompletionsText('<garcon-schedule every="5m" busy="skip" />'),
      chatCompletionsToolUse('call_schedule_gate', 'bash', {
        command: `while [ ! -f "${releasePath}" ]; do sleep 0.05; done`,
      }),
    ]);
    const held = environment.model.scriptHeldTurn([chatCompletionsText('Synthetic result acknowledged.')]);
    try {
      await withIntegrationFixture('opencode-scripted-agent-commands', async (fixture) => {
        const chatId = fixture.newChatId();
        releasePath = join(fixture.dirs.project, 'release-schedule-tool');
        const cursor = fixture.client.markEvents();
        const start = scriptedOpenCodeStartRequest({ chatId, projectPath: fixture.dirs.project, command: 'Issue the synthetic command.' });
        const active = await fixture.client.startChat(start);
        const event = await fixture.client.waitForEvent(
          (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === chatId
            && event.messages.some(({ message }) => message.type === 'transcript-notice' && message.detail?.type === 'agent-schedule-outcome'),
          'schedule creation outcome', { afterIndex: cursor, timeoutMs: 60_000 },
        );
        const outcome = messagesOfType(event.messages, 'transcript-notice').find((notice) => notice.detail?.type === 'agent-schedule-outcome')?.detail;
        if (outcome?.type !== 'agent-schedule-outcome' || outcome.status !== 'created') throw new Error('Schedule was not created');
        const result = garconCommandResultContent(outcome);
        const native = await openCodeNativeSession(fixture, chatId);
        const deadline = Date.now() + 10_000;
        while (!readOpenCodeSessionRows(native).parts.some((part) => part.data.text === result)) {
          if (Date.now() >= deadline) throw new Error('Result was not persisted before releasing the tool');
          await Bun.sleep(10);
        }
        await writeFile(releasePath, 'release', 'utf8');
        expect((await held.requested).lastUserText).toBe(result);
        held.release();
        await fixture.client.waitForTurnTerminal(chatId, active.turnId, { afterIndex: cursor, timeoutMs: 60_000 });
        const transcript = await fixture.client.getMessages(chatId);
        expect(userContents(transcript.messages)).toEqual([start.command]);
        expect(messagesOfType(transcript.messages, 'assistant-message').map((message) => message.content)).toContain('Synthetic result acknowledged.');
        expect(messagesOfType(transcript.messages, 'transcript-notice').filter((notice) => notice.detail?.type === 'agent-schedule-outcome')).toHaveLength(1);
        expect(JSON.stringify(transcript.messages)).not.toContain('<garcon-schedule');
        expect((await fixture.client.getScheduledPrompts()).prompts).toMatchObject([{
          id: outcome.scheduleId, target: { type: 'existing-chat', chatId, busyBehavior: 'skip' },
          schedule: { intervalMinutes: 5 }, prompt: '<garcon-schedule-action />',
        }]);
        environment.model.assertSettled();
      }, environment);
    } finally {
      if (releasePath) await writeFile(releasePath, 'release', 'utf8').catch(() => undefined);
      held.release();
      environment.dispose();
    }
  }, 120_000);
});
