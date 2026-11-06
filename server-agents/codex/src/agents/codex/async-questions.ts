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

export function codexAsyncQuestions(id: string, delivery: unknown, value: unknown): AsyncQuestionSet | undefined {
  if (delivery !== 'async' || !Array.isArray(value) || value.length > 100
    || value.some(question => isRecord(question) && Array.isArray(question.options)
      && (question.options.length === 0 || question.options.length > 100))) return undefined;
  return parseAsyncQuestionSet({
    id,
    questions: value.map((question, index) => isRecord(question) ? {
      id: JSON.stringify(['request_user_input_async', id, index]),
      prompt: question.title,
      options: question.options == null ? [] : Array.isArray(question.options)
        ? question.options.map((label, optionIndex) => ({ id: `option-${optionIndex}`, label }))
        : null,
      allowFreeText: true,
    } : null),
  });
}

// Matches Codex 0.166.0's context-fragments/src/answered_question.rs.
export function codexQuestionReplyInput(content: string, reply?: AsyncQuestionReply): string {
  if (!reply) return content;
  const readable = asyncQuestionReplyText(reply);
  const position = content.lastIndexOf(readable);
  if (position < 0) throw new Error('Question reply does not match its input');
  if (Buffer.byteLength(reply.questionId) > 512) return content;
  let question = '';
  for (const character of reply.question) {
    if (Buffer.byteLength(question + character) > 512) break;
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
    const replies = values.map(value => {
      if (!isRecord(value)) throw new Error('Invalid reply');
      return parseAsyncQuestionReply({
        questionId: value.questionItemId, question: value.question, answer: value.answer,
      })!;
    });
    return new UserMessage(timestamp, replies.map(asyncQuestionReplyText).join('\n\n'), undefined, {
      ...(upstreamRequestId ? { upstreamRequestId } : {}),
      ...(replies.length === 1 ? { questionReply: replies[0] } : {}),
    });
  } catch {
    return null;
  }
}
