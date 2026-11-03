import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runCli, withCliFixture } from '../../support/cli-fixture.js';
import { codexFinalAnswerMessage, type CodexScriptedItem } from '../../support/fake-codex-model.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { LIVE_TURN_TIMEOUT_MS, waitForVisibleResponse } from '../../support/live-agent.js';
import { startScriptedCodexTestEnvironment, type ScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { rejectionOf } from '../../support/promise-assertions.js';

function questionCall(callId: string): CodexScriptedItem {
  return {
    type: 'function_call',
    name: 'request_user_input',
    call_id: callId,
    arguments: JSON.stringify({
      questions: [
        {
          id: 'mode',
          header: 'Mode',
          question: 'Which mode?',
          options: [
            { label: 'Fast', description: 'Quick path' },
            { label: 'Careful', description: 'Detailed path' },
          ],
        },
      ],
    }),
  };
}

describe('scripted Codex synchronous questions', () => {
  let environment: ScriptedCodexTestEnvironment;
  beforeEach(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });
  afterEach(async () => {
    await environment?.dispose();
  });

  for (const mode of ['option', 'text', 'notes', 'skip'] as const) {
    test(`returns ${mode} through the original tool request, including manual bypass`, async () => {
      const callId = `call-question-${mode}`;
      const reply = `QUESTION_${mode}_COMPLETE`;
      let originalUserTexts: readonly string[] = [];
      environment.model.scriptTurn((request) => {
        originalUserTexts = request.userTexts;
        return [questionCall(callId)];
      });
      environment.model.scriptTurn((request) => {
        const output = request.functionCallOutputs.find((item) => item.callId === callId);
        expect(output).toBeDefined();
        const expectedAnswer = mode === 'text' ? 'Custom mode' : 'Careful';
        const nativeValues = mode === 'notes' ? ['Careful', 'user_note: Only tests\nKeep defaults.'] : [expectedAnswer];
        const answers = mode === 'skip' ? {} : { mode: { answers: nativeValues } };
        expect(JSON.parse(output!.output)).toEqual({ answers });
        expect(request.userTexts).toEqual(originalUserTexts);
        return [codexFinalAnswerMessage(reply)];
      });
      await withCliFixture(
        `codex-question-${mode}`,
        async (fixture) => {
          const chatId = fixture.newChatId();
          const cursor = fixture.client.markEvents();
          const turn = await fixture.client.startChat(
            liveCodexStartRequest({
              chatId,
              projectPath: fixture.executionDirs.project,
              command: 'Ask which mode to use.',
              permissionMode: 'manualBypass',
            }),
          );
          const permission = await fixture.client.waitForTransientPermission(chatId, () => true, {
            afterIndex: cursor,
            timeoutMs: LIVE_TURN_TIMEOUT_MS,
          });
          expect(permission.message.requestedTool).toMatchObject({
            type: 'ask-user-question-tool-use',
            toolId: callId,
            questions: [{ id: 'mode', allowFreeText: true, allowNotes: true }],
          });
          const serverInstanceId = (await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.serverInstanceId;
          const fences = ['--run', permission.runId, '--server-instance', serverInstanceId, '--json'];
          const plainAllow = await runCli(fixture, [
            'permission-decision',
            chatId,
            permission.permissionOccurrenceId,
            'allow',
            ...fences,
          ]);
          expect(plainAllow.exitCode).toBe(2);
          expect(plainAllow.stderr).toContain('invalid structured answer');
          expect((await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.rows).toHaveLength(1);
          const invalid = await runCli(fixture, [
            'permission-answer',
            chatId,
            permission.permissionOccurrenceId,
            '--answers',
            JSON.stringify([{ questionId: 'mode', selectedOptionIds: ['missing'] }]),
            ...fences,
          ]);
          expect(invalid.exitCode).toBe(2);
          expect(invalid.stderr).toContain('unknown option ID');
          expect((await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.rows).toHaveLength(1);
          const answers = [
            {
              questionId: 'mode',
              selectedOptionIds: mode === 'text' ? [] : ['option-1'],
              ...(mode === 'text' ? { text: 'Custom mode' } : {}),
              ...(mode === 'notes' ? { text: 'Only tests\nKeep defaults.' } : {}),
            },
          ];
          const decision = await runCli(
            fixture,
            mode === 'skip'
              ? ['permission-decision', chatId, permission.permissionOccurrenceId, 'deny', ...fences]
              : [
                  'permission-answer',
                  chatId,
                  permission.permissionOccurrenceId,
                  '--answers',
                  JSON.stringify(answers),
                  ...fences,
                ],
          );
          expect(decision).toMatchObject({ exitCode: 0, stderr: '' });
          await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor });
          const transcript = await fixture.client.getMessages(chatId);
          const resolution = transcript.messages.find((entry) => entry.message.type === 'permission-resolved')?.message;
          expect(resolution).toMatchObject({
            type: 'permission-resolved',
            allowed: mode !== 'skip',
            ...(mode === 'skip'
              ? {}
              : { questionResponse: { type: 'ask-user-question-response', outcome: 'answered', answers } }),
          });
          expect((await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.rows).toEqual([]);
          await fixture.restartGarcon();
          expect((await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.rows).toEqual([]);
          expect(
            (await fixture.client.getMessages(chatId)).messages.find(
              (entry) => entry.message.type === 'permission-resolved',
            )?.message,
          ).toEqual(resolution);
          environment.model.assertSettled();
        },
        { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace },
      );
    }, 90_000);
  }

  for (const end of ['stop', 'restart'] as const) {
    test(`keeps unanswered question history inert after ${end}`, async () => {
      environment.model.scriptTurn([questionCall(`call-${end}`)]);
      await withCliFixture(
        `codex-question-${end}`,
        async (fixture) => {
          const chatId = fixture.newChatId();
          const cursor = fixture.client.markEvents();
          await fixture.client.startChat(
            liveCodexStartRequest({ chatId, projectPath: fixture.executionDirs.project, command: 'Ask for input.' }),
          );
          const permission = await fixture.client.waitForTransientPermission(chatId, () => true, {
            afterIndex: cursor,
            timeoutMs: LIVE_TURN_TIMEOUT_MS,
          });
          const control = {
            serverInstanceId: (await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.serverInstanceId,
            chatId,
            runId: permission.runId,
            permissionOccurrenceId: permission.permissionOccurrenceId,
          };
          if (end === 'restart') await fixture.restartGarcon();
          else {
            const stopCursor = fixture.client.markEvents();
            await fixture.client.stopChat({ chatId, clientRequestId: crypto.randomUUID() });
            await fixture.client.waitForProcessing(chatId, false, { afterIndex: stopCursor });
          }
          expect((await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.rows).toEqual([]);
          expect(
            (await fixture.client.getMessages(chatId)).messages.some(
              (entry) =>
                entry.message.type === 'permission-request' &&
                entry.message.permissionOccurrenceId === permission.permissionOccurrenceId,
            ),
          ).toBe(true);
          expect(
            await rejectionOf(
              fixture.client.sendPermissionDecision({
                clientRequestId: crypto.randomUUID(),
                chatId,
                permissionOccurrenceId: permission.permissionOccurrenceId,
                allow: false,
                alwaysAllow: false,
                control,
              }),
            ),
          ).toMatchObject({ status: 409, body: { errorCode: 'PERMISSION_NOT_ACTIONABLE' } });
          environment.model.assertSettled();
        },
        { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace },
      );
    }, 90_000);
  }
});
