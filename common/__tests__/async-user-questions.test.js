import { describe, expect, it } from 'bun:test';
import { AssistantMessage, UserMessage, parseChatMessage } from '../chat-types.js';
import { asyncQuestionReplyText, parseAsyncQuestionReply, parseAsyncQuestionSet } from '../async-user-questions.js';
import { extractGarconCommands } from '../garcon-commands.js';
import { parseAgentRunCommandRequest, parseSteerCommandRequest, parseQueueEntryCreateCommandRequest, parseStartChatCommandRequest, parseForkRunCommandRequest } from '../chat-command-contracts.js';

const question = { id: 'question-1', prompt: 'Which environment?', options: [{ id: 'option-0', label: 'Staging' }], allowFreeText: true };
const questions = { id: 'message-1', questions: [question] };
const source = { chatId: '1000000000000001', transcriptViewId: 'view-1', ordinal: 3 };
const reply = { questionId: question.id, question: question.prompt, answer: '  Staging\nOnly tests.  ', source };
const request = { ...source, clientRequestId: 'request-1', clientMessageId: 'message-1', expectedAgentId: 'codex', expectedAgentOwnershipEpoch: 'owner-1', questionReply: reply };

describe('conversational questions', () => {
  it('does not execute in-band commands quoted in a structured question', () => {
    expect(extractGarconCommands(new AssistantMessage('now', '<garcon-get-chat-id />', questions))).toBeNull();
  });
  it('round trips assistant questions and readable user replies without permission data', () => {
    const assistant = new AssistantMessage('2026-01-01T00:00:00Z', 'Fallback text', questions);
    expect(parseChatMessage(JSON.parse(JSON.stringify(assistant)))).toEqual(assistant);
    const user = new UserMessage(assistant.timestamp, asyncQuestionReplyText(reply), undefined, { questionReply: reply });
    expect(parseChatMessage(JSON.parse(JSON.stringify(user)))).toEqual(user);
    expect(user.content).toBe('> Which environment?\n\n  Staging\nOnly tests.  ');
  });
  it.each([
    {}, { ...questions, questions: [] }, { ...questions, questions: [question, question] },
    { ...questions, questions: [{ ...question, isSecret: true }] },
    { ...questions, questions: [{ ...question, prompt: 'x'.repeat(16385) }] },
    { ...questions, questions: [{ ...question, options: [question.options[0], question.options[0]] }] },
  ])('degrades malformed optional question data to assistant text', value => {
    expect(parseAsyncQuestionSet(value)).toBeUndefined();
    expect(parseChatMessage({ type: 'assistant-message', timestamp: 'now', content: 'Keep this', questions: value }))
      .toMatchObject({ content: 'Keep this', questions: undefined });
  });
  it('bounds replies and validates exact sources', () => {
    expect(parseAsyncQuestionReply(reply)).toEqual(reply);
    for (const malformed of [{ ...reply, answer: ' ' }, { ...reply, answer: 'x'.repeat(16385) },
      { ...reply, source: { ...source, ordinal: 0 } }, { ...reply, secret: true }]) {
      expect(() => parseAsyncQuestionReply(malformed)).toThrow();
    }
  });
  it('preserves typed correlation only on ownership-fenced direct run and steer', () => {
    const command = asyncQuestionReplyText(reply);
    expect(parseAgentRunCommandRequest({ ...request, command }).questionReply).toEqual(reply);
    expect(parseSteerCommandRequest({ ...request, content: command })).toMatchObject({ questionReply: reply, expectedAgentOwnershipEpoch: 'owner-1' });
    for (const fields of [{ expectedAgentOwnershipEpoch: undefined }, { expectedAgentId: undefined },
      { questionReply: { ...reply, source: { ...source, chatId: '1000000000000002' } } }, { whenTurnUnavailable: 'queue' }]) {
      expect(() => parseSteerCommandRequest({ ...request, content: command, ...fields })).toThrow();
    }
    expect(() => parseAgentRunCommandRequest({ ...request, command: 'Different text' })).toThrow();
    for (const parse of [parseQueueEntryCreateCommandRequest, parseStartChatCommandRequest, parseForkRunCommandRequest]) {
      expect(() => parse({ ...request, command, content: command })).toThrow('direct run or steer');
    }
  });
});
