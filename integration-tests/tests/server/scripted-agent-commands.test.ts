import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StartChatCommandRequest } from '../../../common/chat-command-contracts.js';
import type { AgentStartOutcomeNoticeDetail } from '../../../common/garcon-agent-result.js';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { escapeGarconXmlText } from '../../../common/garcon-command-envelope.js';
import { garconCommandResultContent } from '../../../common/garcon-command-results.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { chatCompletionsText, chatCompletionsToolUse } from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture, type IntegrationFixture, type IntegrationFixtureOptions } from '../../support/integration-fixture.js';
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
  script(reply: (input: string) => string | Promise<string>): void;
  settled(): void;
  dispose(): void | Promise<void>;
}

async function environmentFor(agent: string): Promise<ScriptedCommands> {
  if (agent === 'codex') {
    const environment = await startScriptedCodexTestEnvironment();
    return { fixtureOptions: environment, startRequest: liveCodexStartRequest,
      script: (reply) => environment.model.scriptTurn(async (request) => [codexAssistantMessage(await reply(request.lastUserText))]),
      settled: () => environment.model.assertSettled(), dispose: () => environment.dispose() };
  }
  if (agent === 'claude') {
    const environment = await startScriptedClaudeTestEnvironment();
    return { fixtureOptions: environment, startRequest: liveClaudeStartRequest,
      script: (reply) => environment.model.scriptTurn(async (request) => [claudeText(await reply(request.lastUserText))]),
      settled: () => environment.model.assertSettled(), dispose: () => environment.dispose() };
  }
  const environment = startScriptedPiTestEnvironment();
  return { fixtureOptions: environment, startRequest: scriptedPiStartRequest,
    script: (reply) => environment.model.scriptTurn(async (request) => [chatCompletionsText(await reply(request.lastUserText))]),
    settled: () => environment.model.assertSettled(), dispose: () => environment.dispose() };
}

async function childOutcome(fixture: IntegrationFixture, chatId: string, status: string, afterIndex: number): Promise<AgentStartOutcomeNoticeDetail> {
  const event = await fixture.client.waitForEvent(
    (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === chatId
      && event.messages.some(({ message }) => message.type === 'transcript-notice'
        && message.detail?.type === 'agent-start-outcome' && message.detail.status === status),
    `child ${status} outcome`, { afterIndex, timeoutMs: 60_000 },
  );
  const detail = messagesOfType(event.messages, 'transcript-notice').find((notice) =>
    notice.detail?.type === 'agent-start-outcome' && notice.detail.status === status)?.detail;
  if (detail?.type !== 'agent-start-outcome') throw new Error('Missing child outcome');
  return detail;
}

describe('scripted provider agent commands', () => {
  for (const agent of ['pi', 'opencode'] as const) {
    (agent !== 'opencode' || process.platform === 'linux' ? test : test.skip)(`${agent} receives child acknowledgment and completion at active Bash boundaries`, async () => {
      const environment = agent === 'pi' ? startScriptedPiTestEnvironment() : startScriptedOpenCodeTestEnvironment();
      const paths: string[] = [];
      let command = '';
      const acknowledgment = Promise.withResolvers<string>();
      const gate = (index: number) => `touch "${paths[index]}.started"; while [ ! -f "${paths[index]}" ]; do sleep 0.05; done`;
      environment.model.scriptTurn(() => [chatCompletionsText(command), chatCompletionsToolUse('call_child_admission', 'bash', { command: gate(0) })]);
      environment.model.scriptTurn((request) => {
        acknowledgment.resolve(request.lastUserText);
        return [chatCompletionsText('Synthetic admission acknowledged.'), chatCompletionsToolUse('call_child_completion', 'bash', { command: gate(1) })];
      });
      const terminal = environment.model.scriptHeldTurn([chatCompletionsText('Synthetic child completion acknowledged.')]);
      try {
        await withIntegrationFixture(`${agent}-child-result-boundaries`, async (fixture) => {
          const source = fixture.newChatId();
          const childAgent = fixture.directAgents.openAiResponses;
          paths.push(join(fixture.dirs.project, 'release-child-admission'), join(fixture.dirs.project, 'release-child-completion'));
          command = `<garcon-start-agent ref="boundary" agent="${childAgent.agentId}" provider="${childAgent.provider.providerId}" model="${childAgent.provider.model}">Synthetic boundary child.</garcon-start-agent>`;
          const child = fixture.fakeProviders.openAiResponses.holdNext({ lastUserText: 'Synthetic boundary child.' });
          const cursor = fixture.client.markEvents();
          const request = { chatId: source, projectPath: fixture.dirs.project, command: 'Delegate the synthetic boundary task.' };
          const start = agent === 'pi' ? scriptedPiStartRequest(request) : scriptedOpenCodeStartRequest(request);
          const active = await fixture.client.startChat(start);
          const nativePersistence = async (text: string) => {
            if (agent !== 'opencode') return;
            const native = await openCodeNativeSession(fixture, source);
            const deadline = Date.now() + 10_000;
            while (!readOpenCodeSessionRows(native).parts.some((part) => part.data.text === text)) {
              if (Date.now() >= deadline) throw new Error('Child result did not persist at the active tool boundary');
              await Bun.sleep(10);
            }
          };
          const accepted = await childOutcome(fixture, source, 'accepted', cursor);
          await child.received;
          await nativePersistence(garconCommandResultContent(accepted));
          await writeFile(paths[0]!, 'release', 'utf8');
          expect(await acknowledgment.promise).toBe(garconCommandResultContent(accepted));
          const boundaryDeadline = Date.now() + 10_000;
          while (!await Bun.file(`${paths[1]}.started`).exists()) {
            if (Date.now() >= boundaryDeadline) throw new Error('Completion Bash boundary was not entered');
            await Bun.sleep(10);
          }
          child.releaseText('Synthetic child answer with <text> & values.');
          const completed = await childOutcome(fixture, source, 'completed', cursor);
          expect(completed).toMatchObject({ output: { availability: 'available', text: 'Synthetic child answer with <text> & values.' } });
          await nativePersistence(garconCommandResultContent(completed));
          await writeFile(paths[1]!, 'release', 'utf8');
          expect((await terminal.requested).lastUserText).toBe(garconCommandResultContent(completed));
          terminal.release();
          expect((await fixture.client.waitForTurnTerminal(source, active.turnId, { afterIndex: cursor, timeoutMs: 60_000 })).type).toBe('agent-run-finished');
          const history = await fixture.client.getMessages(source);
          expect(userContents(history.messages)).toEqual([start.command]);
          expect(messagesOfType(history.messages, 'transcript-notice').filter((notice) => notice.detail?.type === 'agent-start-outcome')).toHaveLength(2);
          environment.model.assertSettled();
        }, environment);
      } finally {
        for (const path of paths) await writeFile(path, 'release', 'utf8').catch(() => undefined);
        terminal.release(); environment.dispose();
      }
    }, 120_000);
  }

  for (const agent of ['claude', 'codex']) {
    test(`${agent} reports exact snapshot-child and resumed-turn results through its real binary`, async () => {
      const environment = await environmentFor(agent);
      const admitted = Promise.withResolvers<void>();
      const resumed = Promise.withResolvers<void>();
      try {
        await withIntegrationFixture(`${agent}-scripted-child-results`, async (fixture) => {
          const source = fixture.newChatId();
          const start = environment.startRequest({ chatId: source, projectPath: fixture.dirs.project, command: 'Delegate the synthetic discussion.' });
          const childPrompt = 'Inspect the copied synthetic discussion.';
          const followup = 'Inspect the synthetic follow-up.';
          const received: string[] = [];
          const command = `<garcon-start-agent ref="snapshot" fork="true" title="Synthetic delegated review" agent="${agent}" model="${escapeGarconXmlText(start.model)}" reasoning-effort="${start.thinkingMode}">${childPrompt}</garcon-start-agent>`;
          environment.script(() => `Synthetic source context.\n${command}`);
          const respond = async (input: string) => {
            received.push(input);
            if (input.endsWith(childPrompt)) {
              expect(input).toContain('<carried-context version="3">');
              expect(input).toContain(start.command);
              expect(input).toContain('Synthetic source context.');
              expect(input.split(childPrompt)).toHaveLength(2);
              await admitted.promise;
              return 'Only the synthetic child answer.';
            }
            if (input.endsWith(followup)) {
              await resumed.promise;
              return 'Only the synthetic resumed answer.';
            }
            if (input.includes('status="accepted"')) {
              if (input.includes('ref="snapshot"')) admitted.resolve();
              else resumed.resolve();
              return 'Synthetic admission observed.';
            }
            if (input.includes('<garcon-start-agent-result') && input.includes('status="completed"')) {
              const childId = /chat-id="([0-9]{16})"/.exec(input)?.[1];
              if (!childId) throw new Error('Missing admitted child ID');
              return `<garcon-resume-agent ref="followup" chat-id="${childId}">${followup}</garcon-resume-agent>`;
            }
            if (input.includes('<garcon-resume-agent-result') && input.includes('status="completed"')) return 'Synthetic completion observed.';
            throw new Error('Unexpected synthetic model input');
          };
          for (let i = 0; i < 6; i++) environment.script(respond);
          const cursor = fixture.client.markEvents();
          await fixture.client.startChat(start);
          await fixture.client.waitForEvent(
            (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === source
              && event.messages.some(({ message }) => message.type === 'assistant-message' && message.content === 'Synthetic completion observed.'),
            'exact resumed result observed', { afterIndex: cursor, timeoutMs: 90_000 },
          );
          const history = await fixture.client.getMessages(source);
          const outcomes = messagesOfType(history.messages, 'transcript-notice').flatMap((notice) =>
            notice.detail?.type === 'agent-start-outcome' || notice.detail?.type === 'agent-resume-outcome' ? [notice.detail] : []);
          expect(outcomes.map((detail) => [detail.type, detail.ref, detail.status])).toEqual([
            ['agent-start-outcome', 'snapshot', 'accepted'], ['agent-start-outcome', 'snapshot', 'completed'],
            ['agent-resume-outcome', 'followup', 'accepted'], ['agent-resume-outcome', 'followup', 'completed'],
          ]);
          for (const detail of outcomes) {
            const envelope = garconCommandResultContent(detail);
            expect(received.filter((input) => input.endsWith(envelope))).toHaveLength(1);
            expect(envelope).not.toContain('turn-id=');
          }
          expect(outcomes[1]).toMatchObject({ output: { availability: 'available', text: 'Only the synthetic child answer.' } });
          expect(outcomes[3]).toMatchObject({ output: { availability: 'available', text: 'Only the synthetic resumed answer.' } });
          const accepted = outcomes[0];
          if (accepted?.status !== 'accepted') throw new Error('Missing accepted child');
          expect((await fixture.client.getChatSnapshot(accepted.chatId)).chat.title).toBe('Synthetic delegated review');
          expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === accepted.chatId)?.parentChat)
            .toEqual({ chatId: source, relation: 'delegation' });
          expect(userContents(history.messages)).toEqual([start.command]);
          expect(userContents((await fixture.client.getMessages(accepted.chatId)).messages)).toEqual([start.command, childPrompt, followup]);
          environment.settled();
        }, environment.fixtureOptions);
      } finally { admitted.resolve(); resumed.resolve(); await environment.dispose(); }
    }, 120_000);
  }

  for (const [agent, createsChild] of [['claude', true], ['codex', true], ['claude', false], ['codex', false], ['pi', false]] as const) {
    test(`${agent} accepts ${createsChild ? 'a child start' : 'a schedule'} and receives its private result through its real binary`, async () => {
      const environment = await environmentFor(agent);
      try {
        await withIntegrationFixture(`${agent}-scripted-agent-commands`, async (fixture) => {
          const source = fixture.newChatId();
          const start = environment.startRequest({ chatId: source, projectPath: fixture.dirs.project, command: 'Issue the synthetic command.' });
          const childPrompt = 'Independent synthetic child task.';
          const command = createsChild
            ? `<garcon-start-agent ref="task" async="true" agent="${agent}" model="${escapeGarconXmlText(start.model)}" reasoning-effort="${start.thinkingMode}">${childPrompt}</garcon-start-agent>`
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
          expect(outcomes[0]!.detail).toMatchObject({ status: createsChild ? 'accepted' : 'created' });
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
