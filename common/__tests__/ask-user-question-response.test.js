import { describe, expect, it } from 'bun:test';
import {
  askUserQuestionDecisionValidationError,
  normalizeAskUserQuestionDecisionResponse,
  ASK_USER_QUESTION_TEXT_MAX_BYTES,
} from '../ask-user-question-response.ts';
import {
  AskUserQuestionToolUseMessage,
  BashToolUseMessage,
} from '../chat-types.ts';

const TIMESTAMP = '2026-09-08T00:00:00.000Z';

describe('free-text question answers', () => {
  const tool = new AskUserQuestionToolUseMessage(TIMESTAMP, 'question', undefined, [{
    id: 'detail', prompt: 'Which detail?', options: [{ id: 'preset', label: 'Preset' }], allowFreeText: true,
  }]);
  const response = (text, selectedOptionIds = []) => ({ type: 'ask-user-question-response', outcome: 'answered',
    answers: [{ questionId: 'detail', selectedOptionIds, text }] });

  it('preserves exact text, bounds UTF-8, and rejects malformed text', () => {
    expect(normalizeAskUserQuestionDecisionResponse(response('  Custom detail  '))).toEqual(response('  Custom detail  '));
    for (const text of ['', '   ', '\ud800', 'a'.repeat(ASK_USER_QUESTION_TEXT_MAX_BYTES + 1), '\u00e9'.repeat(ASK_USER_QUESTION_TEXT_MAX_BYTES)]) {
      expect(normalizeAskUserQuestionDecisionResponse(response(text))).toBeNull();
    }
  });
  it('requires a text capability and an exclusive answer', () => {
    expect(askUserQuestionDecisionValidationError(tool, true, response('Custom'))).toBeNull();
    expect(askUserQuestionDecisionValidationError(tool, true, response('Custom', ['preset']))).toContain('either text');
    const restricted = new AskUserQuestionToolUseMessage(TIMESTAMP, 'restricted', undefined, [{ ...tool.questions[0], allowFreeText: false }]);
    expect(askUserQuestionDecisionValidationError(restricted, true, response('Custom'))).toContain('does not accept free text');
  });
  it('requires text on free-text-only questions, not empty selections', () => {
    const textOnly = new AskUserQuestionToolUseMessage(TIMESTAMP, 'text-only', undefined, [{ ...tool.questions[0], options: [] }]);
    expect(askUserQuestionDecisionValidationError(textOnly, true, response(undefined))).toContain('requires text');
    expect(askUserQuestionDecisionValidationError(textOnly, true, response('Custom'))).toBeNull();
  });
});
const answered = {
  type: 'ask-user-question-response',
  outcome: 'answered',
  answers: [
    { questionId: 'mode', selectedOptionIds: ['careful'] },
    { questionId: 'databases', selectedOptionIds: ['postgres', 'sqlite'] },
    { questionId: 'confirmation', selectedOptionIds: [] },
  ],
};

function questionTool() {
  return new AskUserQuestionToolUseMessage(TIMESTAMP, 'tool-1', 'Configure', [
    {
      id: 'mode',
      prompt: 'Which mode?',
      options: [
        { id: 'fast', label: 'Fast' },
        { id: 'careful', label: 'Careful' },
      ],
    },
    {
      id: 'databases',
      prompt: 'Which databases?',
      options: [
        { id: 'postgres', label: 'Postgres' },
        { id: 'sqlite', label: 'SQLite' },
      ],
      allowMultiple: true,
    },
    {
      id: 'confirmation',
      prompt: 'Continue?',
      options: [],
    },
  ]);
}

describe('structured question decision validation', () => {
  it('accepts exact generic and Cursor question answers', () => {
    expect(askUserQuestionDecisionValidationError(questionTool(), true, answered)).toBeNull();
    expect(askUserQuestionDecisionValidationError(
      new AskUserQuestionToolUseMessage(TIMESTAMP, 'tool-2', 'Configure', [{
        id: 'mode',
        prompt: 'Which mode?',
        options: [{ id: 'careful', label: 'Careful' }],
      }]),
      true,
      {
        type: 'ask-user-question-response',
        outcome: 'answered',
        answers: [{ questionId: 'mode', selectedOptionIds: ['careful'] }],
      },
    )).toBeNull();
    expect(askUserQuestionDecisionValidationError(questionTool(), false, {
      type: 'ask-user-question-response',
      outcome: 'skipped',
      reason: 'Not now',
    })).toBeNull();
  });

  it('rejects structured responses for non-question permissions', () => {
    expect(askUserQuestionDecisionValidationError(
      new BashToolUseMessage(TIMESTAMP, 'tool-1', 'echo hello'),
      true,
      answered,
    )).toBe('Structured answers require a pending question request');
  });

  it('requires exact question and option identities with valid cardinality', () => {
    const tool = questionTool();
    const invalidAnswers = [
      {
        ...answered,
        answers: answered.answers.filter((answer) => answer.questionId !== 'confirmation'),
      },
      {
        ...answered,
        answers: answered.answers.map((answer) => answer.questionId === 'mode'
          ? { ...answer, questionId: 'unknown' }
          : answer),
      },
      {
        ...answered,
        answers: answered.answers.map((answer) => answer.questionId === 'mode'
          ? { ...answer, selectedOptionIds: ['unknown'] }
          : answer),
      },
      {
        ...answered,
        answers: answered.answers.map((answer) => answer.questionId === 'mode'
          ? { ...answer, selectedOptionIds: [] }
          : answer),
      },
      {
        ...answered,
        answers: answered.answers.map((answer) => answer.questionId === 'mode'
          ? { ...answer, selectedOptionIds: ['fast', 'careful'] }
          : answer),
      },
      {
        ...answered,
        answers: answered.answers.map((answer) => answer.questionId === 'confirmation'
          ? { ...answer, selectedOptionIds: ['yes'] }
          : answer),
      },
    ];

    for (const response of invalidAnswers) {
      expect(askUserQuestionDecisionValidationError(tool, true, response)).not.toBeNull();
    }
    expect(askUserQuestionDecisionValidationError(tool, false, answered))
      .toBe('An answered question response must allow the request');
    expect(askUserQuestionDecisionValidationError(tool, true, {
      type: 'ask-user-question-response',
      outcome: 'skipped',
    })).toBe('A skipped question response must deny the request');
  });
});
