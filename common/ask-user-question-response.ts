import type { AskUserQuestionPrompt, ToolUseChatMessage } from './chat-types.js';

export interface AskUserQuestionAnswerPayload {
  questionId: string;
  selectedOptionIds: string[];
  text?: string;
}

export const ASK_USER_QUESTION_MAX_ANSWERS = 100;
export const ASK_USER_QUESTION_MAX_SELECTED_OPTIONS = 100;
export const ASK_USER_QUESTION_ID_MAX_BYTES = 1_024;
export const ASK_USER_QUESTION_REASON_MAX_BYTES = 4_096;
export const ASK_USER_QUESTION_TEXT_MAX_BYTES = 16 * 1_024;
export const ASK_USER_QUESTION_RESPONSE_MAX_BYTES = 64 * 1_024;

const responseEncoder = new TextEncoder();

export interface AskUserQuestionAnsweredResponse extends Record<string, unknown> {
  type: 'ask-user-question-response';
  outcome: 'answered';
  answers: AskUserQuestionAnswerPayload[];
}

export interface AskUserQuestionSkippedResponse extends Record<string, unknown> {
  type: 'ask-user-question-response';
  outcome: 'skipped';
  reason?: string;
}

export type AskUserQuestionDecisionResponse =
  | AskUserQuestionAnsweredResponse
  | AskUserQuestionSkippedResponse;

export function normalizeAskUserQuestionDecisionResponse(
  value: unknown,
): AskUserQuestionDecisionResponse | null {
  const response = asRecord(value);
  if (!response || response.type !== 'ask-user-question-response') return null;

  let normalized: AskUserQuestionDecisionResponse;
  if (response.outcome === 'answered') {
    const answers = normalizeAnswers(response);
    if (!answers) return null;
    normalized = { type: 'ask-user-question-response', outcome: 'answered', answers };
  } else if (response.outcome === 'skipped') {
    if (!hasExactKeys(response, ['type', 'outcome'], ['reason'])) return null;
    if (
      response.reason !== undefined
      && !boundedText(response.reason, ASK_USER_QUESTION_REASON_MAX_BYTES)
    ) return null;
    normalized = {
      type: 'ask-user-question-response',
      outcome: 'skipped',
      ...(response.reason === undefined ? {} : { reason: response.reason }),
    };
  } else {
    return null;
  }

  if (responseEncoder.encode(JSON.stringify(normalized)).byteLength > ASK_USER_QUESTION_RESPONSE_MAX_BYTES) {
    return null;
  }
  return normalized;
}

export function askUserQuestionDecisionValidationError(
  requestedTool: ToolUseChatMessage,
  allow: boolean,
  response: AskUserQuestionDecisionResponse,
): string | null {
  if (requestedTool.type !== 'ask-user-question-tool-use' || !requestedTool.questions) {
    return 'Structured answers require a pending question request';
  }
  const questions = requestedTool.questions;

  if (response.outcome === 'skipped') {
    return allow ? 'A skipped question response must deny the request' : null;
  }
  if (!allow) return 'An answered question response must allow the request';

  const questionIds = new Set(questions.map((question) => question.id));
  if (questionIds.size !== questions.length) {
    return 'The pending question request contains duplicate question IDs';
  }

  const answersById = new Map(response.answers.map((answer) => [answer.questionId, answer]));
  for (const answer of response.answers) {
    if (!questionIds.has(answer.questionId)) {
      return `Structured answers contain an unknown question ID: ${answer.questionId}`;
    }
  }
  if (answersById.size !== questions.length || answersById.size !== response.answers.length) {
    return 'Structured answers must answer every pending question exactly once';
  }

  for (const question of questions) {
    const answer = answersById.get(question.id)!;
    if (answer.text !== undefined) {
      const hasSelections = answer.selectedOptionIds.length > 0;
      if (!hasSelections && !question.allowFreeText) {
        return `Question ${question.id} does not accept free text`;
      }
      if (!boundedText(answer.text, ASK_USER_QUESTION_TEXT_MAX_BYTES)) {
        return `Question ${question.id} requires valid nonblank text`;
      }
      if (hasSelections && !question.allowNotes) {
        return `Question ${question.id} accepts either text or option selections`;
      }
      if (!hasSelections) continue;
    }
    if (question.allowFreeText && question.options.length === 0) {
      return `Question ${question.id} requires text`;
    }
    const error = selectedOptionsValidationError(question, answer.selectedOptionIds);
    if (error) return error;
  }
  return null;
}

function selectedOptionsValidationError(
  question: AskUserQuestionPrompt,
  selectedOptionIds: readonly string[],
): string | null {
  const optionIds = new Set(question.options.map((option) => option.id));
  if (optionIds.size !== question.options.length) {
    return `Pending question ${question.id} contains duplicate option IDs`;
  }
  for (const optionId of selectedOptionIds) {
    if (!optionIds.has(optionId)) {
      return `Structured answers contain an unknown option ID for ${question.id}: ${optionId}`;
    }
  }

  if (question.options.length === 0) {
    return selectedOptionIds.length === 0
      ? null
      : `Question ${question.id} does not accept option selections`;
  }
  if (selectedOptionIds.length === 0) {
    return `Question ${question.id} requires an option selection`;
  }
  if (!question.allowMultiple && selectedOptionIds.length !== 1) {
    return `Question ${question.id} accepts exactly one option`;
  }
  return null;
}

function normalizeAnswers(response: Record<string, unknown>): AskUserQuestionAnswerPayload[] | null {
  if (
    !hasExactKeys(response, ['type', 'outcome', 'answers'])
    || !Array.isArray(response.answers)
    || response.answers.length > ASK_USER_QUESTION_MAX_ANSWERS
  ) return null;

  const answers: AskUserQuestionAnswerPayload[] = [];
  const questionIds = new Set<string>();
  for (const value of response.answers) {
    const answer = asRecord(value);
    if (!answer || !hasExactKeys(answer, ['questionId', 'selectedOptionIds'], ['text'])) return null;
    if (answer.text !== undefined && !boundedText(answer.text, ASK_USER_QUESTION_TEXT_MAX_BYTES)) {
      return null;
    }
    if (!isAskUserQuestionId(answer.questionId) || questionIds.has(answer.questionId)) return null;
    if (
      !Array.isArray(answer.selectedOptionIds)
      || answer.selectedOptionIds.length > ASK_USER_QUESTION_MAX_SELECTED_OPTIONS
    ) {
      return null;
    }
    const selectedOptionIds = normalizeOptionIds(answer.selectedOptionIds);
    if (!selectedOptionIds) return null;
    questionIds.add(answer.questionId);
    answers.push({
      questionId: answer.questionId,
      selectedOptionIds,
      ...(answer.text === undefined ? {} : { text: answer.text }),
    });
  }
  return answers;
}

function normalizeOptionIds(values: unknown[]): string[] | null {
  const optionIds = new Set<string>();
  for (const value of values) {
    if (!isAskUserQuestionId(value) || optionIds.has(value)) return null;
    optionIds.add(value);
  }
  return [...optionIds];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isAskUserQuestionId(value: unknown): value is string {
  return boundedText(value, ASK_USER_QUESTION_ID_MAX_BYTES);
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.isWellFormed()
    && responseEncoder.encode(value).byteLength <= maxBytes;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}
