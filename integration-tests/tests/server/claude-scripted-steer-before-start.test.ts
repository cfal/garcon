import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { userContents } from '../../support/chat-assertions.js';
import { ClaudeSessionStartGate } from '../../support/claude-session-start-gate.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { GarconApiError, type GarconTestClient } from '../../support/garcon-client.js';
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

  test('queues steers the turn cannot take yet and delivers them in order once it can', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const gate = new ClaudeSessionStartGate();
    const prompt = marker('FIRST_PROMPT');
    const firstSteer = marker('FIRST_STEER');
    const secondSteer = marker('SECOND_STEER');
    const requestCursor = testEnvironment.model.markRequests();
    const held = testEnvironment.model.scriptHeldTurn([claudeText(marker('FIRST_REPLY'))]);
    testEnvironment.model.scriptTurn([claudeText(marker('STEER_REPLY'))]);

    await withIntegrationFixture('claude-steers-queued-before-start', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      if (!started.turnId) throw new Error('Scripted Claude start did not return a turn identity.');

      const queuedSteers = [];
      for (const content of [firstSteer, secondSteer]) {
        queuedSteers.push(await fixture.client.steer({
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          chatId,
          content,
          whenTurnUnavailable: 'queue',
        }));
      }
      expect(queuedSteers.map((response) => response.delivery)).toEqual(['queued', 'queued']);
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries
        .map((entry) => [entry.content, entry.kind])).toEqual([
        [firstSteer, 'steer'],
        [secondSteer, 'steer'],
      ]);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([prompt]);

      await gate.open();
      await held.requested;
      await waitForEmptyQueue(fixture.client, chatId);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
        prompt,
        firstSteer,
        secondSteer,
      ]);
      held.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, started.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const [promptRequest, steerRequest] = testEnvironment.model.requestsSince(requestCursor);
      expect(JSON.stringify(promptRequest?.body)).not.toContain(firstSteer);
      const steerText = steerRequest?.lastUserText ?? '';
      expect(steerText.indexOf(firstSteer)).toBeGreaterThanOrEqual(0);
      expect(steerText.indexOf(secondSteer)).toBeGreaterThan(steerText.indexOf(firstSteer));
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: (directories) => gate.install(directories),
    });
  }, 120_000);

  test('keeps a queued message steered before the turn can take it and delivers it into that turn', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const gate = new ClaudeSessionStartGate();
    const prompt = marker('FIRST_PROMPT');
    const queuedPrompt = marker('QUEUED_PROMPT');
    const requestCursor = testEnvironment.model.markRequests();
    const held = testEnvironment.model.scriptHeldTurn([claudeText(marker('FIRST_REPLY'))]);
    testEnvironment.model.scriptTurn([claudeText(marker('STEER_REPLY'))]);

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

      const kept = await fixture.client.steerQueued({
        clientRequestId: crypto.randomUUID(),
        chatId,
        entryId: source.id,
        expectedRevision: source.revision,
        expectedReorderRevision: queued.control.queue.reorderRevision,
      });
      expect(kept).toMatchObject({ delivery: 'queued', entryId: source.id });
      expect(kept.control?.queue.entries).toEqual([
        expect.objectContaining({ id: source.id, kind: 'steer' }),
      ]);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([prompt]);

      await gate.open();
      await held.requested;
      await waitForEmptyQueue(fixture.client, chatId);
      held.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, started.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
        prompt,
        queuedPrompt,
      ]);
      const requests = testEnvironment.model.requestsSince(requestCursor);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.lastUserText).toContain(queuedPrompt);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: (directories) => gate.install(directories),
    });
  }, 120_000);
});

async function waitForEmptyQueue(client: GarconTestClient, chatId: string): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while ((await client.getExecutionControl(chatId)).queue.entries.length > 0) {
    if (Date.now() > deadline) throw new Error('Queued steers were not delivered');
    await Bun.sleep(20);
  }
}

function marker(label: string): string {
  return `CLAUDE_STEER_BEFORE_START_${label}_${crypto.randomUUID()}`;
}
