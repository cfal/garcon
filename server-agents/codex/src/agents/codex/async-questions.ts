import { UserMessage } from '@garcon/common/chat-types';
import {
  asyncQuestionReplyText,
  parseAsyncQuestionReply,
  parseAsyncQuestionSet,
  type AsyncQuestionReply,
  type AsyncQuestionSet,
} from '@garcon/common/async-user-questions';
import { isRecord } from '@garcon/common/json';

const REPLY_START = '<send_user_message_question_reply>';
const REPLY_END = '</send_user_message_question_reply>';
const NATIVE_REPLY_FIELD_MAX_BYTES = 512;

export function codexAsyncQuestions(id: string, delivery: unknown, value: unknown): AsyncQuestionSet | undefined {
  if (delivery !== 'async' || !Array.isArray(value) || value.length > 100) return undefined;

  const questions = [];
  for (const [index, question] of value.entries()) {
    if (!isRecord(question)) return undefined;
    const suggestions = question.options ?? [];
    if (!Array.isArray(suggestions) || suggestions.length > 100) return undefined;
    if (question.options != null && suggestions.length === 0) return undefined;

    questions.push({
      id: JSON.stringify(['request_user_input_async', id, index]),
      prompt: question.title,
      options: suggestions.map((label, optionIndex) => ({ id: `option-${optionIndex}`, label })),
      allowFreeText: true,
    });
  }
  return parseAsyncQuestionSet({ id, questions });
}

// Matches Codex 0.166.0's context-fragments/src/answered_question.rs.
export function codexQuestionReplyInput(content: string, reply?: AsyncQuestionReply): string {
  if (!reply) return content;
  const readable = asyncQuestionReplyText(reply);
  const position = content.lastIndexOf(readable);
  if (position < 0) throw new Error('Question reply does not match its input');
  // Oversized native identities use readable text rather than a reply envelope.
  if (Buffer.byteLength(reply.questionId) > NATIVE_REPLY_FIELD_MAX_BYTES) return content;
  let question = '';
  for (const character of reply.question) {
    if (Buffer.byteLength(question + character) > NATIVE_REPLY_FIELD_MAX_BYTES) break;
    question += character;
  }
  const envelope = `${REPLY_START}\n${JSON.stringify([{
    questionItemId: reply.questionId,
    question: question.replace(/[\r\n]/g, ' '),
    answer: reply.answer,
  }])}\n${REPLY_END}`;
  // Keeps composed prior input, preambles, and appended file context intact.
  return content.slice(0, position) + envelope + content.slice(position + readable.length);
}

export function codexHistoricalQuestionReply(
  timestamp: string, content: string, upstreamRequestId?: string,
): UserMessage | null {
  const text = content.trim();
  if (!text.startsWith(REPLY_START) || !text.endsWith(REPLY_END)) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(REPLY_START.length, -REPLY_END.length));
    const values = Array.isArray(parsed) ? parsed : [parsed];
    if (values.length === 0 || values.length > 100) return null;
    const replies: AsyncQuestionReply[] = [];
    for (const value of values) {
      if (!isRecord(value)) return null;
      replies.push(parseAsyncQuestionReply({
        questionId: value.questionItemId, question: value.question, answer: value.answer,
      })!);
    }
    return new UserMessage(timestamp, replies.map(asyncQuestionReplyText).join('\n\n'), undefined, {
      ...(upstreamRequestId ? { upstreamRequestId } : {}),
      ...(replies.length === 1 ? { questionReply: replies[0] } : {}),
    });
  } catch {
    return null;
  }
}
