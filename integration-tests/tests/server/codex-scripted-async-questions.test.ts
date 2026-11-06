import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asyncQuestionReplyText, type AsyncQuestionReply } from '../../../common/async-user-questions.js';
import { FILE_CONTEXT_SEPARATOR } from '../../../common/file-mention-context.js';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { codexFinalAnswerMessage } from '../../support/fake-codex-model.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { reloadUntilNativeContains } from '../../support/live-agent.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('async questions continue immediately and accept correlated ordinary input during and after a turn', async () => {
  const environment = await startScriptedCodexTestEnvironment({ supportedTools: ['request_user_input_async'] });
  environment.model.scriptTurn([{
    type: 'function_call', name: 'request_user_input_async', call_id: 'call-async',
    arguments: JSON.stringify({ questions: [
      { title: 'Which environment?', options: ['Staging', 'Production'] }, { title: 'Deadline?' },
    ] }),
  }]);
  const continued = environment.model.scriptHeldStreamTurn([codexFinalAnswerMessage('UNUSED_INITIAL_REPLY')]);
  const steered = environment.model.scriptHeldTurn([codexFinalAnswerMessage('ASYNC_STEER_COMPLETE')]);
  const interrupted = environment.model.scriptHeldStreamTurn([codexFinalAnswerMessage('UNUSED_INTERRUPTED_REPLY')]);
  environment.model.scriptTurn([codexFinalAnswerMessage('ASYNC_IDLE_COMPLETE')]);
  try {
    await withIntegrationFixture('codex-async-questions', async fixture => {
      let client = fixture.client;
      const chatId = fixture.newChatId();
      const turn = await client.startChat(liveCodexStartRequest({ chatId, projectPath: fixture.executionDirs.project, command: 'Ask for environment and deadline.' }));
      await continued.requested;
      await client.waitForEvent((event): event is ChatMessagesMessage => event.type === 'chat-messages'
        && event.chatId === chatId && event.messages.some(entry => entry.message.type === 'assistant-message' && !!entry.message.questions), 'async question publication');
      const snapshot = await client.getChatSnapshot(chatId, 0);
      expect(snapshot.transientFeed.rows).toEqual([]);
      const history = await client.getMessages(chatId);
      const row = history.messages.find(entry => entry.message.type === 'assistant-message' && entry.message.questions);
      if (row?.message.type !== 'assistant-message' || !row.message.questions) throw new Error('Expected structured questions');
      expect(history.messages.filter(entry => entry.message.type === 'assistant-message' && entry.message.questions)).toHaveLength(1);
      const prompts = row.message.questions.questions;
      const questionText = row.message.content;
      const forkId = fixture.newChatId();
      await client.forkChat({ sourceChatId: chatId, chatId: forkId, upToOrdinal: row.ordinal,
        transcriptViewId: history.transcriptViewId, allowHandoffFork: true });
      const frozen = await client.getMessages(forkId);
      const copied = frozen.messages.find(entry => entry.message.type === 'assistant-message'
        && entry.message.content === questionText);
      expect(copied?.message).toMatchObject({ type: 'assistant-message', content: questionText });
      expect(copied?.message.type === 'assistant-message' && copied.message.questions).toBeUndefined();
      expect((await client.getChatSnapshot(forkId, 0)).chat.canReloadFromNativeHistory).toBe(false);
      const source = { chatId, transcriptViewId: history.transcriptViewId, ordinal: row.ordinal };
      const reply: AsyncQuestionReply = { questionId: prompts[0].id, question: prompts[0].prompt, answer: '  Staging\nOnly tests.  ', source };
      const request = { chatId, transcriptViewId: history.transcriptViewId,
        expectedAgentId: snapshot.chat.agentId, expectedAgentOwnershipEpoch: snapshot.chat.agentOwnershipEpoch,
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        questionReply: reply, content: asyncQuestionReplyText(reply) };
      expect(await rejectionOf(client.steer({ ...request, expectedAgentOwnershipEpoch: 'old-owner' })))
        .toMatchObject({ status: 409, body: { errorCode: 'STALE_CHAT_OWNERSHIP' } });
      expect(await rejectionOf(client.steer({ ...request, questionReply: { ...reply, source: { ...source, ordinal: 1 } } })))
        .toMatchObject({ status: 400 });
      expect(await rejectionOf(client.steer({ ...request,
        questionReply: { ...reply, source: { ...source, ordinal: Number.MAX_SAFE_INTEGER } } })))
        .toMatchObject({ status: 400, body: { errorCode: 'VALIDATION_FAILED' } });
      expect(await rejectionOf(client.steer({ ...request, whenTurnUnavailable: 'queue' }))).toMatchObject({ status: 400 });
      const response = await client.steer(request);
      expect(response.turnId).toBe(turn.turnId);
      expect(await client.steer(request)).toMatchObject({ status: 'duplicate', turnId: turn.turnId });
      await steered.requested;
      continued.release();
      steered.release();
      await client.waitForTurnTerminal(chatId, turn.turnId);
      const modelRequests = environment.model.requests();
      expect(modelRequests[1].functionCallOutputs).toContainEqual({ callId: 'call-async', output: '{"accepted":true}' });
      expect(modelRequests[2].lastUserText).toContain('<send_user_message_question_reply>');
      expect(modelRequests[2].lastUserText).toContain(JSON.stringify(reply.answer));
      expect((await client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      const recorded = await client.getMessages(chatId);
      expect(recorded.messages.filter(entry => entry.message.type === 'user-message' && entry.message.metadata?.questionReply)).toHaveLength(1);
      expect(recorded.messages.find(entry => entry.message.type === 'user-message' && entry.message.metadata?.questionReply)?.message)
        .toMatchObject({ content: request.content, metadata: { questionReply: reply } });

      await fixture.restartGarcon();
      client = fixture.client;
      expect((await client.getMessages(chatId)).messages).toEqual(recorded.messages);
      const declinedInput = 'DECLINED_RESEND_INPUT';
      const stopped = await client.runChat({ chatId, command: declinedInput,
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
      await interrupted.requested;
      await client.stopChat({ chatId, clientRequestId: crypto.randomUUID() });
      await client.waitForTurnTerminal(chatId, stopped.turnId);
      const unsent = (await client.getMessages(chatId)).messages.find(entry =>
        entry.message.type === 'user-message' && entry.message.content === declinedInput);
      if (!unsent) throw new Error('Missing interrupted input');
      const laterReply = { ...reply, questionId: prompts[1].id, question: prompts[1].prompt, answer: 'Friday; use @sample.txt' };
      const repeatedText = asyncQuestionReplyText(laterReply);
      await writeFile(join(fixture.executionDirs.project, 'sample.txt'), repeatedText);
      const later = await client.runChat({ ...request, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        command: asyncQuestionReplyText(laterReply), questionReply: laterReply, excludedResendOrdinals: [unsent.ordinal] });
      await client.waitForTurnTerminal(chatId, later.turnId);
      const nativeInput = environment.model.requests()[4].lastUserText;
      expect(nativeInput).not.toContain(declinedInput);
      const fileContext = `${FILE_CONTEXT_SEPARATOR}@sample.txt\n\`\`\`\n${repeatedText}\n\`\`\``;
      expect(nativeInput).toEndWith(fileContext);
      expect(nativeInput.slice(0, nativeInput.indexOf(FILE_CONTEXT_SEPARATOR)))
        .toContain(`"answer":${JSON.stringify(laterReply.answer)}`);
      await reloadUntilNativeContains(fixture, chatId, 'ASYNC_IDLE_COMPLETE');
      const reloaded = await client.getMessages(chatId);
      expect(reloaded.messages.some(entry => entry.message.type === 'assistant-message' && entry.message.questions?.id === 'call-async')).toBe(true);
      expect(reloaded.messages.some(entry => entry.message.type === 'user-message'
        && entry.message.metadata?.questionReply?.answer === laterReply.answer)).toBe(true);
      expect(await rejectionOf(client.steer(request))).toMatchObject({ status: 409, body: { errorCode: 'STALE_TRANSCRIPT_VIEW' } });
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
  } finally {
    continued.release();
    steered.release();
    interrupted.release();
    await environment.dispose();
  }
}, 120_000);

test('steering an async answer does not resolve a simultaneous blocking question', async () => {
  const environment = await startScriptedCodexTestEnvironment({ supportedTools: ['request_user_input_async'] });
  environment.model.scriptTurn([
    { type: 'function_call', name: 'request_user_input_async', call_id: 'call-conversation', arguments: JSON.stringify({ questions: [{ title: 'Which environment?' }] }) },
    { type: 'function_call', name: 'request_user_input', call_id: 'call-blocking', arguments: JSON.stringify({ questions: [{ id: 'confirm', header: 'Confirm', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue work' }] }] }) },
  ]);
  environment.model.scriptTurn([codexFinalAnswerMessage('BOTH_ANSWERS_RECEIVED')]);
  try {
    await withIntegrationFixture('codex-async-with-blocking', async fixture => {
      const { client } = fixture;
      const chatId = fixture.newChatId();
      const turn = await client.startChat(liveCodexStartRequest({ chatId, projectPath: fixture.executionDirs.project, command: 'Ask independent questions.' }));
      const permission = await client.waitForTransientPermission(chatId, () => true);
      const snapshot = await client.getChatSnapshot(chatId, 0);
      const history = await client.getMessages(chatId);
      const row = history.messages.find(entry => entry.message.type === 'assistant-message' && entry.message.questions);
      if (row?.message.type !== 'assistant-message' || !row.message.questions) throw new Error('Missing conversational question');
      const question = row.message.questions.questions[0];
      const reply = { questionId: question.id, question: question.prompt, answer: 'Staging', source: { chatId, transcriptViewId: history.transcriptViewId, ordinal: row.ordinal } };
      await client.steer({ chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        expectedAgentId: snapshot.chat.agentId, expectedAgentOwnershipEpoch: snapshot.chat.agentOwnershipEpoch,
        content: asyncQuestionReplyText(reply), questionReply: reply });
      expect((await client.getChatSnapshot(chatId, 0)).transientFeed.rows).toHaveLength(1);
      expect(environment.model.requests()).toHaveLength(1);
      await client.sendPermissionDecision({ chatId, clientRequestId: crypto.randomUUID(), permissionOccurrenceId: permission.permissionOccurrenceId,
        allow: true, alwaysAllow: false, response: { type: 'ask-user-question-response', outcome: 'answered', answers: [{ questionId: 'confirm', selectedOptionIds: ['option-0'] }] } });
      await client.waitForTurnTerminal(chatId, turn.turnId);
      const next = environment.model.requests()[1];
      expect(next.lastUserText).toContain('"answer":"Staging"');
      expect(next.functionCallOutputs).toContainEqual({ callId: 'call-blocking', output: '{"answers":{"confirm":{"answers":["Yes"]}}}' });
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
  } finally { await environment.dispose(); }
}, 120_000);
