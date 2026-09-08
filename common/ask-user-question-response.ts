export interface AskUserQuestionAnswerPayload {
  questionId: string;
  selectedOptionIds: string[];
}

export const ASK_USER_QUESTION_MAX_ANSWERS = 100;
export const ASK_USER_QUESTION_MAX_SELECTED_OPTIONS = 100;
export const ASK_USER_QUESTION_ID_MAX_BYTES = 1_024;
export const ASK_USER_QUESTION_REASON_MAX_BYTES = 4_096;
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
    if (
      !answer
      || !hasExactKeys(answer, ['questionId', 'selectedOptionIds'])
      || !boundedId(answer.questionId)
      || questionIds.has(answer.questionId)
      || !Array.isArray(answer.selectedOptionIds)
      || answer.selectedOptionIds.length > ASK_USER_QUESTION_MAX_SELECTED_OPTIONS
    ) return null;
    const selectedOptionIds = normalizeOptionIds(answer.selectedOptionIds);
    if (!selectedOptionIds) return null;
    questionIds.add(answer.questionId);
    answers.push({ questionId: answer.questionId, selectedOptionIds });
  }
  return answers;
}

function normalizeOptionIds(values: unknown[]): string[] | null {
  const optionIds = new Set<string>();
  for (const value of values) {
    if (!boundedId(value) || optionIds.has(value)) return null;
    optionIds.add(value);
  }
  return [...optionIds];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedId(value: unknown): value is string {
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
