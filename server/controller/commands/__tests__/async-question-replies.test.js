import { expect, it, mock } from 'bun:test';
import { CommandSupport } from '../command-support.js';
import { asyncQuestionReplyText } from '../../../../common/async-user-questions.js';
import { AssistantMessage, UserMessage } from '../../../../common/chat-types.js';
import { submissionFingerprint } from '../../ledger/codec.js';

const question = { id: 'question', prompt: 'Which environment?', options: [], allowFreeText: true };
const reply = { questionId: question.id, question: question.prompt, answer: 'Staging', source: { chatId: 'chat', transcriptViewId: 'view', ordinal: 5 } };
const input = { chatId: 'chat', transcriptViewId: 'view', expectedAgentId: 'codex', expectedAgentOwnershipEpoch: 'epoch', questionReply: reply };

function fixture() {
  const row = { ordinal: 5, kind: 'provider-row', message: new AssistantMessage('now', question.prompt, { id: 'set', questions: [question] }) };
  const view = { viewId: 'view', contentStartOrdinal: 1 };
  const replayRows = mock(() => [row]);
  const support = new CommandSupport({
    chats: { getChat: () => ({ agentId: 'codex', agentOwnershipEpoch: 'epoch' }) },
    transcripts: { currentView: () => view, highWatermark: () => ({ viewId: view.viewId, ordinal: 5 }), replayRows },
  });
  return { support, row, view, replayRows };
}

it('checks the exact source with a one-row bounded read', () => {
  const { support, replayRows } = fixture();
  support.assertQuestionReply(input, asyncQuestionReplyText(reply));
  expect(replayRows).toHaveBeenCalledWith('chat', 'view', 4, 5, 1);
});

it('rejects prior ownership, replaced views, copied references, and substituted questions', () => {
  const { support, row, view } = fixture();
  for (const mutation of [{ expectedAgentId: 'other' }, { expectedAgentOwnershipEpoch: 'old' },
    { questionReply: { ...reply, source: { ...reply.source, chatId: 'copied-chat' } } },
    { questionReply: { ...reply, source: { ...reply.source, transcriptViewId: 'old' } } },
    { questionReply: { ...reply, questionId: 'absent' } }]) {
    expect(() => support.assertQuestionReply({ ...input, ...mutation }, asyncQuestionReplyText(reply))).toThrow();
  }
  expect(() => support.assertQuestionReply(input, 'different content')).toThrow();
  view.contentStartOrdinal = 6;
  expect(() => support.assertQuestionReply(input, asyncQuestionReplyText(reply))).toThrow();
  view.contentStartOrdinal = 1;
  row.message = new UserMessage('now', 'Not a question');
  expect(() => support.assertQuestionReply(input, asyncQuestionReplyText(reply))).toThrow();
});

it('includes answer identity and source in durable input fingerprints', () => {
  const detail = { message: new UserMessage('now', asyncQuestionReplyText(reply), undefined, { questionReply: reply }), attachments: [], steer: true };
  const fingerprint = submissionFingerprint(detail);
  detail.message.metadata.questionReply = { ...reply, questionId: 'different' };
  expect(submissionFingerprint(detail)).not.toBe(fingerprint);
  detail.message.metadata.questionReply = { ...reply, source: { ...reply.source, ordinal: 8 } };
  expect(submissionFingerprint(detail)).not.toBe(fingerprint);
});

it('rejects an ahead-of-view question source before calling the replay reader', () => {
  const { support, replayRows } = fixture();
  const ahead = { ...reply, source: { ...reply.source, ordinal: 6 } };
  let error;
  try {
    support.assertQuestionReply({ ...input, questionReply: ahead }, asyncQuestionReplyText(ahead));
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  expect(replayRows).not.toHaveBeenCalled();
});
