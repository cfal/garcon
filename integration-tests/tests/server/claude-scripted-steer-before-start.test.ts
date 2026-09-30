import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { userContents } from '../../support/chat-assertions.js';
import { ClaudeSessionStartGate } from '../../support/claude-session-start-gate.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { GarconApiError } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS } from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

async function apiFailure(request: Promise<unknown>): Promise<GarconApiError> {
  try {
    await request;
  } catch (error) {
    if (error instanceof GarconApiError) return error;
    throw error;
  }
  throw new Error('Expected the request to fail');
}

// Each chat's first turn waits in Claude's SessionStart hook until the test opens the gate, so
// the turn is admitted and running in Garcon while Claude cannot take steering input yet.
describe('scripted Claude steering before the turn can take it', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('refuses the steer without recording it', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const gate = new ClaudeSessionStartGate();
    const prompt = marker('FIRST_PROMPT');
    const steerPrompt = marker('EARLY_STEER');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptTurn([claudeText(marker('FIRST_REPLY'))]);

    await withIntegrationFixture('claude-steer-before-start-refused', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      if (!started.turnId) throw new Error('Scripted Claude start did not return a turn identity.');

      const refused = await apiFailure(fixture.client.steer({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        content: steerPrompt,
      }));
      expect(refused).toMatchObject({ status: 409, body: { errorCode: 'STEER_TURN_UNAVAILABLE' } });
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([prompt]);

      await gate.open();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, started.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([prompt]);
      expect(testEnvironment.model.requestsSince(requestCursor)
        .some((request) => JSON.stringify(request.body).includes(steerPrompt))).toBe(false);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: (directories) => gate.install(directories),
    });
  }, 120_000);

  test('keeps a queued message whose steer was refused and runs it next', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const gate = new ClaudeSessionStartGate();
    const prompt = marker('FIRST_PROMPT');
    const queuedPrompt = marker('QUEUED_PROMPT');
    const queuedReply = marker('QUEUED_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptTurn([claudeText(marker('FIRST_REPLY'))]);
    testEnvironment.model.scriptTurn([claudeText(queuedReply)]);

    await withIntegrationFixture('claude-queued-steer-before-start', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      if (!started.turnId) throw new Error('Scripted Claude start did not return a turn identity.');
      const queued = await fixture.client.enqueueNew(chatId, queuedPrompt);
      const source = queued.control.queue.entries[0];
      if (!source) throw new Error('The queued message is missing.');

      const refused = await apiFailure(fixture.client.steerQueued({
        clientRequestId: crypto.randomUUID(),
        chatId,
        entryId: source.id,
        expectedRevision: source.revision,
        expectedReorderRevision: queued.control.queue.reorderRevision,
      }));
      expect(refused).toMatchObject({ status: 409, body: { errorCode: 'STEER_TURN_UNAVAILABLE' } });
      const control = await fixture.client.getExecutionControl(chatId);
      expect(control.queue.entries.map((entry) => entry.id)).toEqual([source.id]);
      expect(control.queue.steeringEntryId).toBeNull();
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([prompt]);

      await gate.open();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, started.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const queuedInput = await fixture.client.waitForCommittedUserInput(chatId, queuedPrompt, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: fixture.client.events().lastIndexOf(queuedInput) + 1,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
        prompt,
        queuedPrompt,
      ]);
      expect(testEnvironment.model.requestsSince(requestCursor).at(-1)?.lastUserText)
        .toContain(queuedPrompt);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: (directories) => gate.install(directories),
    });
  }, 120_000);
});

function marker(label: string): string {
  return `CLAUDE_STEER_BEFORE_START_${label}_${crypto.randomUUID()}`;
}
