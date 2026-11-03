import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AskUserQuestionAnswerPayload } from '../../../common/ask-user-question-response.js';
import { runCli, withCliFixture } from '../../support/cli-fixture.js';
import { codexFinalAnswerMessage, type CodexScriptedItem } from '../../support/fake-codex-model.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { LIVE_TURN_TIMEOUT_MS, reloadUntilNativeContains, waitForVisibleResponse } from '../../support/live-agent.js';
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

const answerScenarios: {
  mode: string;
  answer: AskUserQuestionAnswerPayload | null;
  nativeValues: string[] | null;
}[] = [
  {
    mode: 'option',
    answer: { questionId: 'mode', selectedOptionIds: ['option-1'] },
    nativeValues: ['Careful'],
  },
  {
    mode: 'text',
    answer: { questionId: 'mode', selectedOptionIds: [], text: 'Custom mode' },
    nativeValues: ['Custom mode'],
  },
  {
    mode: 'notes',
    answer: { questionId: 'mode', selectedOptionIds: ['option-1'], text: 'Only tests\nKeep defaults.' },
    nativeValues: ['Careful', 'user_note: Only tests\nKeep defaults.'],
  },
  { mode: 'skip', answer: null, nativeValues: null },
];

describe('scripted Codex synchronous questions', () => {
  let environment: ScriptedCodexTestEnvironment;
  beforeEach(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });
  afterEach(async () => {
    await environment?.dispose();
  });

  for (const { mode, answer, nativeValues } of answerScenarios) {
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
        const answers = nativeValues === null ? {} : { mode: { answers: nativeValues } };
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
          let command: string[];
          if (answer === null) {
            command = ['permission-decision', chatId, permission.permissionOccurrenceId, 'deny', ...fences];
          } else {
            command = [
              'permission-answer',
              chatId,
              permission.permissionOccurrenceId,
              '--answers',
              JSON.stringify([answer]),
              ...fences,
            ];
          }
          const decision = await runCli(fixture, command);
          expect(decision).toMatchObject({ exitCode: 0, stderr: '' });
          await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor });
          const transcript = await fixture.client.getMessages(chatId);
          expect(transcript.messages.filter((entry) => entry.message.type === 'permission-resolved')).toHaveLength(1);
          const resolution = transcript.messages.find((entry) => entry.message.type === 'permission-resolved')?.message;
          if (resolution?.type !== 'permission-resolved') throw new Error('Expected resolved question');
          expect(resolution).toMatchObject({
            type: 'permission-resolved',
            allowed: answer !== null,
          });
          if (answer !== null) {
            expect(resolution.questionResponse).toEqual({
              type: 'ask-user-question-response', outcome: 'answered', answers: [answer],
            });
          }
          const replay = await runCli(fixture, command);
          expect(replay).toMatchObject({ exitCode: 0, stderr: '' });
          expect(JSON.parse(replay.stdout).status).toBe('duplicate');
          expect((await fixture.client.getMessages(chatId)).messages).toEqual(transcript.messages);
          expect((await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.rows).toEqual([]);
          await fixture.restartGarcon();
          expect((await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.rows).toEqual([]);
          expect((await fixture.client.getMessages(chatId)).messages).toEqual(transcript.messages);
          if (mode === 'notes') {
            await reloadUntilNativeContains(fixture, chatId, reply);
            const reloaded = await fixture.client.getMessages(chatId);
            expect(reloaded.transcriptViewId).not.toBe(transcript.transcriptViewId);
            // Paginated Codex history omits question calls; legacy JSONL import has separate coverage.
            expect((await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.rows).toEqual([]);
          }
          environment.model.assertSettled();
        },
        { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace },
      );
    }, 90_000);
  }

  test('answers every question atomically with independent option, note and text identities', async () => {
    const callId = 'call-mixed-questions';
    const answers = [
      { questionId: 'detail', selectedOptionIds: [], text: '  Custom detail\nKeep defaults.  ' },
      { questionId: '__proto__', selectedOptionIds: ['option-1'], text: '  Only tests  ' },
    ];
    environment.model.scriptTurn([{
      type: 'function_call', name: 'request_user_input', call_id: callId,
      arguments: JSON.stringify({ questions: ['__proto__', 'detail'].map((id) => ({
        id, header: 'Choice', question: `Choose ${id}`,
        options: [{ label: 'Fast', description: 'Quick path' }, { label: 'Careful', description: 'Detailed path' }],
      })) }),
    }]);
    environment.model.scriptTurn((request) => {
      const output = request.functionCallOutputs.find((item) => item.callId === callId);
      expect(output).toBeDefined();
      expect(JSON.parse(output!.output)).toEqual({ answers: {
        ['__proto__']: { answers: ['Careful', 'user_note:   Only tests  '] },
        detail: { answers: ['  Custom detail\nKeep defaults.  '] },
      } });
      return [codexFinalAnswerMessage('MIXED_ANSWERS_RECEIVED')];
    });
    await withCliFixture('codex-mixed-questions', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'Ask for both choices.',
      }));
      const permission = await fixture.client.waitForTransientPermission(chatId, () => true, {
        afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      const serverInstanceId = (await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.serverInstanceId;
      const command = ['permission-answer', chatId, permission.permissionOccurrenceId];
      const fences = ['--run', permission.runId, '--server-instance', serverInstanceId, '--json'];
      const partial = await runCli(fixture, [...command, '--answers', JSON.stringify(answers.slice(0, 1)), ...fences]);
      expect(partial.exitCode).toBe(2);
      expect(partial.stderr).toContain('every pending question exactly once');
      expect((await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.rows).toHaveLength(1);
      expect(environment.model.requests()).toHaveLength(1);
      expect((await fixture.client.getMessages(chatId)).messages.some((entry) => entry.message.type === 'permission-resolved'))
        .toBe(false);

      const complete = await runCli(fixture, [...command, '--answers', JSON.stringify(answers), ...fences]);
      expect(complete).toMatchObject({ exitCode: 0, stderr: '' });
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: 'MIXED_ANSWERS_RECEIVED', afterIndex: cursor });
      const resolutions = (await fixture.client.getMessages(chatId)).messages
        .filter((entry) => entry.message.type === 'permission-resolved');
      expect(resolutions).toHaveLength(1);
      const resolution = resolutions[0].message;
      if (resolution.type !== 'permission-resolved') throw new Error('Expected resolved question');
      expect(resolution.allowed).toBe(true);
      expect(resolution.questionResponse).toEqual({
        type: 'ask-user-question-response', outcome: 'answered', answers,
      });
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
  }, 90_000);

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
