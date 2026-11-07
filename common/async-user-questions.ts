import type { AskUserQuestionPrompt } from './chat-types.js';
import { isRecord } from './json.js';
import {
  isAskUserQuestionId,
  ASK_USER_QUESTION_RESPONSE_MAX_BYTES,
  ASK_USER_QUESTION_TEXT_MAX_BYTES,
} from './ask-user-question-response.js';

export interface AsyncQuestionPrompt extends Pick<AskUserQuestionPrompt, 'id' | 'prompt' | 'options'> {
  allowFreeText: true;
}

export interface AsyncQuestionSet {
  id: string;
  questions: AsyncQuestionPrompt[];
}

export interface AsyncQuestionReply {
  questionId: string;
  question: string;
  answer: string;
  source?: {
    chatId: string;
    transcriptViewId: string;
    ordinal: number;
  };
}

const encoder = new TextEncoder();

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.isWellFormed()
    && encoder.encode(value).byteLength <= limit;
}

export function parseAsyncQuestionSet(value: unknown): AsyncQuestionSet | undefined {
  if (
    !isRecord(value)
    || !isAskUserQuestionId(value.id)
    || !Array.isArray(value.questions)
    || value.questions.length === 0
    || value.questions.length > 100
    || encoder.encode(JSON.stringify(value)).byteLength > ASK_USER_QUESTION_RESPONSE_MAX_BYTES
  ) return undefined;

  const questionIds = new Set<string>();
  const questions: AsyncQuestionPrompt[] = [];
  for (const question of value.questions) {
    if (
      !isRecord(question)
      || !isAskUserQuestionId(question.id)
      || questionIds.has(question.id)
      || !boundedText(question.prompt, ASK_USER_QUESTION_TEXT_MAX_BYTES)
      || question.allowFreeText !== true
      || !Array.isArray(question.options)
      || question.options.length > 100
      || question.allowMultiple === true
      || question.allowNotes === true
      || question.isSecret === true
    ) return undefined;
    questionIds.add(question.id);

    const optionIds = new Set<string>();
    const options: AsyncQuestionPrompt['options'] = [];
    for (const option of question.options) {
      if (
        !isRecord(option)
        || !isAskUserQuestionId(option.id)
        || optionIds.has(option.id)
        || !boundedText(option.label, ASK_USER_QUESTION_TEXT_MAX_BYTES)
      ) return undefined;
      optionIds.add(option.id);
      options.push({ id: option.id, label: option.label });
    }
    questions.push({ id: question.id, prompt: question.prompt, options, allowFreeText: true });
  }
  return { id: value.id, questions };
}

export function parseAsyncQuestionReply(value: unknown): AsyncQuestionReply | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value)
    || !isAskUserQuestionId(value.questionId)
    || !boundedText(value.question, ASK_USER_QUESTION_TEXT_MAX_BYTES)
    || !boundedText(value.answer, ASK_USER_QUESTION_TEXT_MAX_BYTES)
    || Object.keys(value).some(key => !['questionId', 'question', 'answer', 'source'].includes(key))
    || encoder.encode(JSON.stringify(value)).byteLength > ASK_USER_QUESTION_RESPONSE_MAX_BYTES
  ) {
    throw new TypeError('Invalid async question reply');
  }
  const source = parseReplySource(value.source);
  return {
    questionId: value.questionId,
    question: value.question,
    answer: value.answer,
    ...(source ? { source } : {}),
  };
}

function parseReplySource(value: unknown): AsyncQuestionReply['source'] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value)
    || !boundedText(value.chatId, 128)
    || !boundedText(value.transcriptViewId, 128)
    || !Number.isSafeInteger(value.ordinal)
    || (value.ordinal as number) < 1
    || Object.keys(value).some(key => !['chatId', 'transcriptViewId', 'ordinal'].includes(key))
  ) {
    throw new TypeError('Invalid async question reply source');
  }
  return { chatId: value.chatId, transcriptViewId: value.transcriptViewId, ordinal: value.ordinal as number };
}

export function asyncQuestionReplyText(reply: AsyncQuestionReply): string {
  const quotedQuestion = reply.question.split(/\r?\n/).map(line => `> ${line}`).join('\n');
  return `${quotedQuestion}\n\n${reply.answer}`;
}
