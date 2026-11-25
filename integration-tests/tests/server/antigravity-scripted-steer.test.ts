import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { withTimeout } from '../../support/deferred.js';
import { geminiFunctionCall, geminiText } from '../../support/fake-gemini-model.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS } from '../../support/live-agent.js';
import {
  ANTIGRAVITY_BINARY,
  scriptedAntigravityStartRequest,
  startScriptedAntigravityTestEnvironment,
  type ScriptedAntigravityTestEnvironment,
} from '../../support/scripted-antigravity.js';

describe.skipIf(!ANTIGRAVITY_BINARY)('scripted Antigravity steering', () => {
  let environment: ScriptedAntigravityTestEnvironment | undefined;

  beforeAll(() => {
    environment = startScriptedAntigravityTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('delivers concurrent steers in committed ledger order within the running turn', async () => {
    if (!environment) throw new Error('Scripted Antigravity environment was not initialized.');
    const { model } = environment;
    const firstPrompt = marker('BATCH_FIRST_PROMPT');
    const firstSteer = marker('BATCH_FIRST_STEER');
    const secondSteer = marker('BATCH_SECOND_STEER');
    const steeredReply = marker('BATCH_STEERED_REPLY');
    const requestCursor = model.markRequests();
    const held = model.scriptHeldTurn([geminiText(marker('BATCH_FIRST_REPLY'))]);
    model.scriptTurn([geminiText(steeredReply)]);

    await withIntegrationFixture('antigravity-scripted-steer-batch', async (fixture) => {
      const chatId = fixture.newChatId();
      const eventCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId,
        projectPath: fixture.executionDirs.project,
        command: firstPrompt,
      }));
      await held.requested;

      const results = await Promise.all([firstSteer, secondSteer].map((content) => fixture.client.steer({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        content,
      })));
      held.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: eventCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      expect(results).toMatchObject([
        { status: 'accepted', turnId: first.turnId },
        { status: 'accepted', turnId: first.turnId },
      ]);
      const transcript = (await fixture.client.getMessages(chatId)).messages;
      const [, earlierSteer = '', laterSteer = ''] = userContents(transcript);
      expect(new Set([earlierSteer, laterSteer])).toEqual(new Set([firstSteer, secondSteer]));
      const requests = model.requestsSince(requestCursor);
      expect(requests).toHaveLength(2);
      const steeredText = requests[1]?.userTexts.join('\n') ?? '';
      expect(steeredText.indexOf(earlierSteer)).toBeGreaterThanOrEqual(0);
      expect(steeredText.indexOf(laterSteer)).toBeGreaterThan(steeredText.indexOf(earlierSteer));
      expect(assistantContents(transcript).at(-1)).toContain(steeredReply);
      model.assertSettled();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: environment.prepareWorkspace,
    }).finally(() => {
      held.release();
      model.reset();
    });
  }, 120_000);

  // agy refuses a prompt while it waits for an answer, so the steer waits in
  // the queue and reaches the same turn once the command is approved.
  test('holds a steer while a command awaits approval and delivers it into the same turn', async () => {
    if (!environment) throw new Error('Scripted Antigravity environment was not initialized.');
    const { model } = environment;
    const prompt = marker('APPROVAL_PROMPT');
    const steer = marker('APPROVAL_STEER');
    const steeredReply = marker('APPROVAL_STEERED_REPLY');
    // The command waits for the barrier, so the steer arrives while the tool runs.
    const command = 'while [ ! -f steer-delivered ]; do sleep 0.05; done; echo ran';
    const requestCursor = model.markRequests();
    model.scriptTurn([geminiFunctionCall('approval-command', 'run_command', {
      CommandLine: command,
      toolSummary: 'Wait for the steering barrier',
      WaitMsBeforeAsync: 10_000,
    })]);
    model.scriptTurn([geminiText(steeredReply)]);

    await withIntegrationFixture('antigravity-scripted-steer-approval', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId,
        projectPath: fixture.executionDirs.project,
        command: prompt,
      }));
      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        (row) => row.message.type === 'permission-request',
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (permission.message.type !== 'permission-request') throw new Error('Expected a command permission request.');

      const queued = await fixture.client.steer({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        content: steer,
        whenTurnUnavailable: 'queue',
      });
      const queueWhilePending = (await fixture.client.getExecutionControl(chatId)).queue.entries
        .map((entry) => [entry.content, entry.kind]);
      const usersWhilePending = userContents((await fixture.client.getMessages(chatId)).messages);
      await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId: permission.message.permissionOccurrenceId,
        allow: true,
        alwaysAllow: false,
      });
      await waitForEmptyQueue(fixture.client, chatId);
      await writeFile(join(fixture.executionDirs.project, 'steer-delivered'), '');
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, started.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      expect(queued).toMatchObject({ delivery: 'queued' });
      expect(queueWhilePending).toEqual([[steer, 'steer']]);
      expect(usersWhilePending).toEqual([prompt]);
      const transcript = (await fixture.client.getMessages(chatId)).messages;
      expect(userContents(transcript)).toEqual([prompt, steer]);
      expect(assistantContents(transcript).at(-1)).toContain(steeredReply);
      const requests = model.requestsSince(requestCursor);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.functionResponses.map((response) => response.id)).toEqual(['approval-command']);
      expect(requests[1]?.userTexts.join('\n')).toContain(steer);
      model.assertSettled();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: environment.prepareWorkspace,
    }).finally(() => model.reset());
  }, 120_000);
});

async function waitForEmptyQueue(client: GarconTestClient, chatId: string): Promise<void> {
  await withTimeout((async () => {
    while ((await client.getExecutionControl(chatId)).queue.entries.length > 0) await Bun.sleep(20);
  })(), LIVE_TURN_TIMEOUT_MS, () => 'The pending steer was not delivered');
}

function marker(label: string): string {
  return `SCRIPTED_ANTIGRAVITY_STEER_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
