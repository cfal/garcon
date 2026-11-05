import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { CodexAppServerClient } from '../../../server-agents/codex/src/agents/codex/app-server/client.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { isolatedEnvironment } from '../../support/garcon-process.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('fails an incomplete Codex response once after its visible output and resumes normally', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  try {
    const partial = 'Synthetic partial output before the response limit.';
    environment.model.scriptFault({
      kind: 'incomplete-response', reason: 'max_output_tokens',
      items: [{ ...codexAssistantMessage(partial), phase: 'commentary' }],
    });
    await withIntegrationFixture('codex-scripted-incomplete', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'Produce a synthetic incomplete response.',
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, started.turnId, { afterIndex: cursor });
      expect(terminal.type).toBe('agent-run-failed');
      expect(terminal).toMatchObject({ error: expect.stringContaining('max_output_tokens') });
      expect(environment.model.requests()).toHaveLength(1);
      const transcript = await fixture.client.getMessages(chatId);
      const partialRow = transcript.messages.find(entry => entry.message.type === 'assistant-message' && entry.message.content === partial);
      expect(partialRow).toBeDefined();

      const events = fixture.client.eventsSince(cursor);
      const partialIndex = events.findIndex((event) => (
        event.type === 'chat-transcript-head-updated' && event.chatId === chatId
        && event.responseClassOrdinals.assistant >= partialRow!.ordinal
      ));
      const terminalIndex = events.indexOf(terminal);
      expect(partialIndex).toBeGreaterThanOrEqual(0);
      expect(terminalIndex).toBeGreaterThan(partialIndex);

      const answer = 'Synthetic answer after the failed response.';
      environment.model.scriptTurn([codexAssistantMessage(answer)]);
      const continuedCursor = fixture.client.markEvents();
      const continued = await fixture.client.runChat(liveCodexRunRequest({
        chatId, command: 'Continue after the synthetic failure.',
      }));
      await waitForVisibleResponse({
        fixture, chatId, turnId: continued.turnId, marker: answer, afterIndex: continuedCursor,
      });
      expect(fixture.client.eventsSince(cursor).filter((event) => (
        (event.type === 'agent-run-failed' || event.type === 'agent-run-finished')
        && event.chatId === chatId && event.turnId === started.turnId
      ))).toHaveLength(1);
      expect(environment.model.requests()).toHaveLength(2);
      environment.model.assertSettled();
    }, environment);
  } finally {
    await environment.dispose();
  }
}, 120_000);

test.each([
  ['model_not_found', 'modelNotFound', 'Synthetic deployment is unavailable.'],
  ['policy_capacity_unavailable', 'policyCapacityUnavailable',
    'Policy-restricted capacity is unavailable. Please try again later.'],
] as const)('preserves terminal %s failures through native pagination and restart', async (code, errorInfo, message) => {
  const environment = await startScriptedCodexTestEnvironment();
  try {
    await withIntegrationFixture(`codex-scripted-${code}`, async (fixture) => {
      const chatId = fixture.newChatId();
      const first = 'Synthetic answer before the provider failure.';
      environment.model.scriptTurn([codexAssistantMessage(first)]);
      const initialCursor = fixture.client.markEvents();
      const initial = await fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'Start a synthetic error test.',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: initial.turnId, marker: first, afterIndex: initialCursor });

      environment.model.scriptFault({ kind: 'stream-error', code, message });
      const failureCursor = fixture.client.markEvents();
      const failed = await fixture.client.runChat(liveCodexRunRequest({ chatId, command: 'Fail this synthetic turn.' }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, failed.turnId, { afterIndex: failureCursor });
      expect(terminal).toMatchObject({ type: 'agent-run-failed', error: message });
      expect(environment.model.requests()).toHaveLength(2);
      const failedTranscript = await fixture.client.getMessages(chatId);
      const errorRow = failedTranscript.messages.find(entry => entry.message.type === 'error' && entry.message.content === message);
      expect(errorRow).toBeDefined();
      const events = fixture.client.eventsSince(failureCursor);
      const errorIndex = events.findIndex((event) => event.type === 'chat-transcript-head-updated' && event.chatId === chatId
        && event.sourceHead >= errorRow!.ordinal);
      expect(errorIndex).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(terminal)).toBeGreaterThan(errorIndex);

      const answer = 'Synthetic answer after the provider failure.';
      environment.model.scriptTurn([codexAssistantMessage(answer)]);
      const continuedCursor = fixture.client.markEvents();
      const continued = await fixture.client.runChat(liveCodexRunRequest({ chatId, command: 'Continue the synthetic session.' }));
      await waitForVisibleResponse({ fixture, chatId, turnId: continued.turnId, marker: answer, afterIndex: continuedCursor });
      expect(fixture.client.eventsSince(failureCursor).filter((event) => (
        (event.type === 'agent-run-failed' || event.type === 'agent-run-finished')
        && event.chatId === chatId && event.turnId === failed.turnId
      ))).toHaveLength(1);
      expect(environment.model.requests()).toHaveLength(3);
      const native = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' });
      await fixture.restartGarcon();
      const persisted = (await fixture.client.getMessages(chatId)).messages;
      expect(persisted.filter((entry) => entry.message.type === 'error' && entry.message.content === message)).toHaveLength(1);
      const persistedErrorIndex = persisted.findIndex((entry) => entry.message.type === 'error' && entry.message.content === message);
      expect(persistedErrorIndex).toBeGreaterThan(persisted.findIndex((entry) => (
        entry.message.type === 'assistant-message' && entry.message.content === first
      )));
      expect(persistedErrorIndex).toBeLessThan(persisted.findIndex((entry) => (
        entry.message.type === 'assistant-message' && entry.message.content === answer
      )));

      const nativeEnv = isolatedEnvironment(fixture.executionDirs.home, {
        ...environment.serverEnvironment, CODEX_HOME: join(fixture.executionDirs.home, '.codex'),
      });
      const codex = new CodexAppServerClient({
        resolveCommand: async () => environment.serverEnvironment.GARCON_CODEX_CLI!,
        spawn: (command, args) => Bun.spawn([command, ...args], {
          env: nativeEnv, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        }),
      });
      try {
        await codex.connect();
        const page = await codex.listThreadTurns({
          threadId: native.agentSessionId!, limit: 100, sortDirection: 'asc', itemsView: 'notLoaded',
        });
        expect(page.nextCursor).toBeNull();
        expect(page.data.map((turn) => turn.status)).toEqual(['completed', 'failed', 'completed']);
        expect(page.data[1]!.error).toMatchObject({ message, codexErrorInfo: errorInfo });
      } finally {
        await codex.shutdown();
      }
      await fixture.client.reloadChat(chatId);
      const reloaded = (await fixture.client.getMessages(chatId)).messages;
      expect(assistantContents(reloaded)).toEqual([first, answer]);
      expect(environment.model.requests()).toHaveLength(3);
      environment.model.assertSettled();
    }, environment);
  } finally {
    await environment.dispose();
  }
}, 120_000);
