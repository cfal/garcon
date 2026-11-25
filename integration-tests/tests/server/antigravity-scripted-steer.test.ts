import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatExecutionControlUpdatedMessage } from '../../../common/ws-events.js';
import { assistantContents, messagesOfType, userContents } from '../../support/chat-assertions.js';
import { withTimeout } from '../../support/deferred.js';
import { geminiFunctionCall, geminiText } from '../../support/fake-gemini-model.js';
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
      const users = userContents(transcript);
      expect(users).toHaveLength(3);
      expect(users[0]).toBe(firstPrompt);
      const [, earlierSteer = '', laterSteer = ''] = users;
      expect(new Set([earlierSteer, laterSteer])).toEqual(new Set([firstSteer, secondSteer]));
      const requests = model.requestsSince(requestCursor);
      expect(requests).toHaveLength(2);
      const steeredText = requests[1]?.userTexts.join('\n') ?? '';
      for (const steer of [earlierSteer, laterSteer]) expect(steeredText.split(steer)).toHaveLength(2);
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

  test.each(['original success', 'success without usage', 'original error', 'steer error'])('attributes a delayed steer: %s', async (outcome) => {
    if (!environment) throw new Error('Scripted Antigravity environment was not initialized.');
    const { model, prepareWorkspace, serverEnvironment } = environment;
    const steer = marker('DELAYED_STEER');
    const reply = marker('DELAYED_REPLY');
    const requestCursor = model.markRequests();
    const fault = { kind: 'http-error', status: 400, message: 'Model request was rejected.', reason: 'INVALID_ARGUMENT' } as const;
    const held = model.scriptHeldTurn(outcome === 'original error' ? fault : [geminiText('Original answer.')], {
      omitUsage: outcome === 'success without usage',
    });
    model.scriptTurn(outcome === 'steer error' ? fault : [geminiText(reply)]);

    await withIntegrationFixture('antigravity-scripted-steer-delayed', async (fixture) => {
      const { client, executionDirs } = fixture;
      const chatId = fixture.newChatId();
      const cursor = client.markEvents();
      const started = await client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: executionDirs.project, command: 'Answer first.',
      }));
      await withTimeout(held.requested, LIVE_TURN_TIMEOUT_MS, () => 'agy did not start the first request');
      const result = client.steer({
        chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), content: steer,
      }).then(ack => ({ ack }), error => ({ error }));
      const release = () => writeFile(join(executionDirs.home, 'release-steer'), '');
      try {
        await waitForWire(() => Bun.file(join(executionDirs.home, 'steer-written')).exists(), 'the steering frame');
        held.release();
        if (outcome === 'steer error') {
          const frames = Bun.file(join(executionDirs.home, 'agy-output'));
          await waitForWire(async () => (await frames.text()).split('\n').slice(0, -1)
            .some(line => JSON.parse(line).result?.stopReason === 'end_turn'), 'the original RPC reply');
          await release();
        }
        expect(await result).toMatchObject(outcome === 'success without usage'
          ? { ack: { status: 'accepted' } } : { error: { body: { errorCode: 'STEER_OUTCOME_UNKNOWN' } } });
      } finally {
        await release();
      }
      const terminal = await client.waitForTurnTerminal(chatId, started.turnId, {
        afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      const transcript = (await client.getMessages(chatId)).messages;
      const answers = assistantContents(transcript);
      if (outcome === 'original error' || outcome === 'steer error') {
        expect(terminal.type).toBe('agent-run-failed');
        expect(messagesOfType(transcript, 'error').map(row => row.content)).toEqual([expect.stringContaining(fault.message)]);
        expect(answers).toEqual([outcome === 'original error' ? reply : 'Original answer.']);
        const output = transcript.map(row => row.message.type).filter(type => type === 'assistant-message' || type === 'error');
        expect(output).toEqual(outcome === 'original error'
          ? ['error', 'assistant-message'] : ['assistant-message', 'error']);
      } else {
        expectFinished(terminal.type);
        if (outcome === 'original success') expect(answers).toEqual(['Original answer.', reply]);
        else expect(answers.join('')).toBe('Original answer.' + reply);
      }
      expect(userContents(transcript)).toEqual(['Answer first.', steer]);
      const requests = model.requestsSince(requestCursor);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.lastUserText).toContain(steer);
      model.assertSettled();
    }, {
      serverEnvironment: { ...serverEnvironment, SCRIPTED_AGY: ANTIGRAVITY_BINARY },
      resolveServerEnvironment: (dirs) => ({ GARCON_ANTIGRAVITY_BINARY: join(dirs.home, 'hold-steer') }),
      async prepareWorkspace(dirs) {
        await prepareWorkspace(dirs);
        // Delays only the steering frame on stdin; every reply comes unmodified from agy.
        await writeFile(join(dirs.home, 'hold-steer'), [
          '#!/bin/sh',
          'if [ "$1" != acp ]; then exec "$SCRIPTED_AGY" "$@"; fi',
          'while IFS= read -r frame; do',
          `  case "$frame" in *${steer}*) touch "$HOME/steer-written"; while [ -d "$HOME" ] && [ ! -f "$HOME/release-steer" ]; do sleep 0.05; done ;; esac`,
          '  printf "%s\\n" "$frame"',
          'done | "$SCRIPTED_AGY" "$@" | tee "$HOME/agy-output"',
        ].join('\n'), { mode: 0o700 });
      },
    }).finally(() => { held.release(); model.reset(); });
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
      const beforeApproval = fixture.client.markEvents();
      try {
        await fixture.client.sendPermissionDecision({
          clientRequestId: crypto.randomUUID(),
          chatId,
          permissionOccurrenceId: permission.message.permissionOccurrenceId,
          allow: true,
          alwaysAllow: false,
        });
        await fixture.client.waitForEvent(
          (event): event is ChatExecutionControlUpdatedMessage => event.type === 'chat-execution-control-updated'
            && event.chatId === chatId && event.control.queue.entries.length === 0,
          'pending steer consumed', { afterIndex: beforeApproval, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        );
      } finally {
        await writeFile(join(fixture.executionDirs.project, 'steer-delivered'), '');
      }
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

async function waitForWire(observed: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (!await observed()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(20);
  }
}

function marker(label: string): string {
  return `SCRIPTED_ANTIGRAVITY_STEER_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
