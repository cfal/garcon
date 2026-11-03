import { describe, expect, it } from 'bun:test';
import {
  askUserQuestionDecisionValidationError,
  normalizeAskUserQuestionDecisionResponse,
  ASK_USER_QUESTION_TEXT_MAX_BYTES,
  ASK_USER_QUESTION_RESPONSE_MAX_BYTES,
} from '../ask-user-question-response.ts';
import {
  AskUserQuestionToolUseMessage,
  BashToolUseMessage,
  parseChatMessage,
} from '../chat-types.ts';

const TIMESTAMP = '2026-09-08T00:00:00.000Z';

describe('free-text question answers', () => {
  const tool = new AskUserQuestionToolUseMessage(TIMESTAMP, 'question', undefined, [
    {
      id: 'detail',
      prompt: 'Which detail?',
      options: [{ id: 'preset', label: 'Preset' }],
      allowFreeText: true,
    },
  ]);
  const response = (text, selectedOptionIds = []) => ({
    type: 'ask-user-question-response',
    outcome: 'answered',
    answers: [{ questionId: 'detail', selectedOptionIds, text }],
  });

  it('preserves exact text, bounds UTF-8, and rejects malformed text', () => {
    expect(normalizeAskUserQuestionDecisionResponse(response('  Custom detail  '))).toEqual(response('  Custom detail  '));
    for (const text of [
      '',
      '   ',
      '\ud800',
      'a'.repeat(ASK_USER_QUESTION_TEXT_MAX_BYTES + 1),
      '\u00e9'.repeat(ASK_USER_QUESTION_TEXT_MAX_BYTES),
    ]) {
      expect(normalizeAskUserQuestionDecisionResponse(response(text))).toBeNull();
    }
  });
  it('requires a text capability and an exclusive answer', () => {
    expect(askUserQuestionDecisionValidationError(tool, true, response('Custom'))).toBeNull();
    expect(askUserQuestionDecisionValidationError(tool, true, response('Custom', ['preset']))).toContain('either text');
    const restricted = new AskUserQuestionToolUseMessage(TIMESTAMP, 'restricted', undefined, [{ ...tool.questions[0], allowFreeText: false }]);
    expect(askUserQuestionDecisionValidationError(restricted, true, response('Custom'))).toContain('does not accept free text');
  });

  it.each(['x', '\u00e9'])('accepts the exact UTF-8 text limit and rejects one more character: %s', (character) => {
    const text = character.repeat(ASK_USER_QUESTION_TEXT_MAX_BYTES / Buffer.byteLength(character));
    for (const selections of [[], ['preset']]) {
      expect(normalizeAskUserQuestionDecisionResponse(response(text, selections)))
        .toEqual(response(text, selections));
      expect(normalizeAskUserQuestionDecisionResponse(response(text + character, selections))).toBeNull();
    }
  });

  it('bounds the complete encoded response even when every answer fits its individual limit', () => {
    const answer = {
      type: 'ask-user-question-response',
      outcome: 'answered',
      answers: Array.from({ length: 4 }, (_, index) => ({
        questionId: `question-${index}`,
        selectedOptionIds: [],
        text: index < 3 ? 'x'.repeat(ASK_USER_QUESTION_TEXT_MAX_BYTES) : '',
      })),
    };
    const remaining = ASK_USER_QUESTION_RESPONSE_MAX_BYTES - Buffer.byteLength(JSON.stringify(answer));
    answer.answers[3].text = 'x'.repeat(remaining);
    expect(Buffer.byteLength(JSON.stringify(answer))).toBe(ASK_USER_QUESTION_RESPONSE_MAX_BYTES);
    expect(normalizeAskUserQuestionDecisionResponse(answer)).toEqual(answer);

    answer.answers[3].text += 'x';
    expect(answer.answers.every(({ text }) => Buffer.byteLength(text) <= ASK_USER_QUESTION_TEXT_MAX_BYTES)).toBe(true);
    expect(normalizeAskUserQuestionDecisionResponse(answer)).toBeNull();
  });

  it('counts JSON escaping toward the response bound, not just raw text bytes', () => {
    const text = 'x' + '\u0001'.repeat(ASK_USER_QUESTION_TEXT_MAX_BYTES - 1);
    expect(Buffer.byteLength(text)).toBe(ASK_USER_QUESTION_TEXT_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(response(text)))).toBeGreaterThan(ASK_USER_QUESTION_RESPONSE_MAX_BYTES);
    expect(normalizeAskUserQuestionDecisionResponse(response(text))).toBeNull();
  });
  it('requires text on free-text-only questions, not empty selections', () => {
    const textOnly = new AskUserQuestionToolUseMessage(TIMESTAMP, 'text-only', undefined, [{ ...tool.questions[0], options: [] }]);
    expect(askUserQuestionDecisionValidationError(textOnly, true, response(undefined))).toContain('requires text');
    expect(askUserQuestionDecisionValidationError(textOnly, true, response('Custom'))).toBeNull();
  });

  it('round-trips the opt-in notes capability and preserves selections with exact text', () => {
    const notesTool = new AskUserQuestionToolUseMessage(TIMESTAMP, 'notes', undefined, [
      { ...tool.questions[0], allowFreeText: false, allowNotes: true },
    ]);
    const decoded = parseChatMessage(JSON.parse(JSON.stringify(notesTool)));
    expect(decoded.questions[0].allowNotes).toBe(true);
    const answer = response('  Only for tests\nKeep the default.  ', ['preset']);
    expect(normalizeAskUserQuestionDecisionResponse(answer)).toEqual(answer);
    expect(askUserQuestionDecisionValidationError(decoded, true, answer)).toBeNull();
    expect(askUserQuestionDecisionValidationError(decoded, true, response('Note without selection')))
      .toContain('does not accept free text');
    expect(askUserQuestionDecisionValidationError(decoded, true, response('Note', ['unknown'])))
      .toContain('unknown option');
    expect(askUserQuestionDecisionValidationError(decoded, true, response('   ', ['preset'])))
      .toContain('nonblank');
    for (const text of ['', '\ud800', 'x'.repeat(ASK_USER_QUESTION_TEXT_MAX_BYTES + 1)]) {
      expect(normalizeAskUserQuestionDecisionResponse(response(text, ['preset']))).toBeNull();
    }
  });

  it('keeps option cardinality validation when notes are present', () => {
    const notesTool = new AskUserQuestionToolUseMessage(TIMESTAMP, 'notes', undefined, [{
      ...tool.questions[0], allowNotes: true,
      options: [{ id: 'preset', label: 'Preset' }, { id: 'second', label: 'Second' }],
    }]);
    const answer = response('Note', ['preset', 'second']);
    expect(askUserQuestionDecisionValidationError(notesTool, true, answer)).toContain('exactly one');
    notesTool.questions[0].allowMultiple = true;
    expect(askUserQuestionDecisionValidationError(notesTool, true, answer)).toBeNull();
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
  it('accepts exact option identities and skipped questions', () => {
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
