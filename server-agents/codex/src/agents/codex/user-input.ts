import { AskUserQuestionToolUseMessage, type AskUserQuestionPrompt } from '@garcon/common/chat-types';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import {
  ASK_USER_QUESTION_ID_MAX_BYTES,
  ASK_USER_QUESTION_MAX_ANSWERS,
  ASK_USER_QUESTION_MAX_SELECTED_OPTIONS,
  askUserQuestionDecisionValidationError,
  normalizeAskUserQuestionDecisionResponse,
} from '@garcon/common/ask-user-question-response';
import { isRecord } from '@garcon/common/json';

export const CODEX_USER_INPUT_METHOD = 'item/tool/requestUserInput';

export interface CodexUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

export function codexUserInputQuestions(value: unknown): AskUserQuestionPrompt[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ASK_USER_QUESTION_MAX_ANSWERS) {
    throw new TypeError('Invalid Codex questions');
  }
  const ids = new Set<string>();
  return value.map((question): AskUserQuestionPrompt => {
    if (
      !isRecord(question) ||
      typeof question.id !== 'string' ||
      !question.id.trim() ||
      !question.id.isWellFormed() ||
      new TextEncoder().encode(question.id).length > ASK_USER_QUESTION_ID_MAX_BYTES ||
      ids.has(question.id) ||
      typeof question.question !== 'string' ||
      !question.question.trim() ||
      (question.isOther !== undefined && typeof question.isOther !== 'boolean') ||
      (question.isSecret !== undefined && typeof question.isSecret !== 'boolean')
    ) {
      throw new TypeError('Invalid Codex question');
    }
    ids.add(question.id);
    const options = question.options ?? [];
    if (!Array.isArray(options) || options.length > ASK_USER_QUESTION_MAX_SELECTED_OPTIONS) {
      throw new TypeError('Invalid Codex question options');
    }
    if (options.length === 0 && question.isOther !== true) throw new TypeError('Unanswerable Codex question');
    return {
      id: question.id,
      prompt: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      allowFreeText: question.isOther === true,
      isSecret: question.isSecret === true,
      options: options.map((option, index) => {
        if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim()) {
          throw new TypeError('Invalid Codex question option');
        }
        return {
          id: `option-${index}`,
          label: option.label,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
        };
      }),
    };
  });
}

export function codexUserInputMessage(
  timestamp: string,
  itemId: unknown,
  questions: unknown,
): AskUserQuestionToolUseMessage {
  if (typeof itemId !== 'string' || !itemId.trim()) throw new TypeError('Missing Codex question item ID');
  return new AskUserQuestionToolUseMessage(timestamp, itemId, undefined, codexUserInputQuestions(questions));
}

export function codexUserInputResponse(
  tool: AskUserQuestionToolUseMessage,
  decision: PermissionDecisionPayload,
): CodexUserInputResponse {
  const response = normalizeAskUserQuestionDecisionResponse(decision.response);
  if (decision.response !== undefined && !response) throw new TypeError('Invalid Codex question response');
  if (response) {
    const error = askUserQuestionDecisionValidationError(tool, decision.allow, response);
    if (error) throw new TypeError(error);
  }
  if (!decision.allow) return { answers: {} };
  if (!response || response.outcome !== 'answered') throw new TypeError('Codex questions require structured answers');
  const questions = new Map(tool.questions.map((question) => [question.id, question]));
  return {
    answers: Object.fromEntries(
      response.answers.map((answer) => [
        answer.questionId,
        {
          answers:
            answer.text !== undefined
              ? [answer.text]
              : answer.selectedOptionIds.map(
                  (id) => questions.get(answer.questionId)!.options.find((option) => option.id === id)!.label,
                ),
        },
      ]),
    ),
  };
}

export function codexHistoricalUserInput(
  timestamp: string,
  callId: string,
  input: Record<string, unknown>,
): AskUserQuestionToolUseMessage {
  try {
    // The native handler adds Other after recording the original model arguments.
    const questions = Array.isArray(input.questions)
      ? input.questions.map((question) => (isRecord(question) ? { ...question, isOther: true } : question))
      : input.questions;
    return codexUserInputMessage(timestamp, callId, questions);
  } catch {
    return new AskUserQuestionToolUseMessage(timestamp, callId, undefined, []);
  }
}

export function codexHistoricalAnswers(output: unknown): Record<string, string[]> | null {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || !isRecord(value.answers)) return null;
  const entries = Object.entries(value.answers);
  if (
    !entries.every(
      ([, answer]) =>
        isRecord(answer) && Array.isArray(answer.answers) && answer.answers.every((text) => typeof text === 'string'),
    )
  )
    return null;
  return Object.fromEntries(entries.map(([id, answer]) => [id, (answer as { answers: string[] }).answers]));
}
