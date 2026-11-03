import { describe, expect, it } from 'bun:test';
import { ASK_USER_QUESTION_ID_MAX_BYTES } from '@garcon/common/ask-user-question-response';
import {
  codexUserInputMessage,
  codexUserInputResponse,
  codexHistoricalUserInput,
  codexHistoricalQuestionResult,
} from '../user-input.js';
import {
  buildApprovalMessage,
  buildApprovalResponse,
  createPendingApproval,
  isApprovalRequest,
} from '../app-server/approvals.js';
import { denialResponseForRequest } from '../app-server/runtime-support.js';

const at = '2026-11-02T00:00:00.000Z';
const questions = [
  {
    id: 'mode',
    header: 'Mode',
    question: 'Which mode?',
    isOther: true,
    isSecret: false,
    options: [
      { label: 'Fast', description: 'Quick path' },
      { label: 'Careful', description: 'Detailed path' },
    ],
  },
];
const tool = codexUserInputMessage(at, 'call-question', questions);

describe('Codex synchronous questions', () => {
  it('uses the generic permission request and maps option identities to native labels', () => {
    const request = {
      id: 17,
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread', turnId: 'turn', itemId: 'call-question', questions },
    };
    expect(isApprovalRequest(request)).toBe(true);
    const pending = createPendingApproval('chat', request);
    expect(buildApprovalMessage(pending).requestedTool).toMatchObject({
      type: 'ask-user-question-tool-use',
      toolId: 'call-question',
      questions: [
        {
          id: 'mode',
          allowFreeText: true,
          allowNotes: true,
          options: [
            { id: 'option-0', label: 'Fast' },
            { id: 'option-1', label: 'Careful' },
          ],
        },
      ],
    });
    expect(
      buildApprovalResponse(pending, {
        allow: true,
        response: {
          type: 'ask-user-question-response',
          outcome: 'answered',
          answers: [{ questionId: 'mode', selectedOptionIds: ['option-1'] }],
        },
      }),
    ).toEqual({ answers: { mode: { answers: ['Careful'] } } });
  });
  it('delivers free text and skips without choosing a default', () => {
    expect(
      codexUserInputResponse(tool, {
        allow: true,
        response: {
          type: 'ask-user-question-response',
          outcome: 'answered',
          answers: [{ questionId: 'mode', selectedOptionIds: [], text: 'Custom mode' }],
        },
      }),
    ).toEqual({ answers: { mode: { answers: ['Custom mode'] } } });
    expect(codexUserInputResponse(tool, { allow: false })).toEqual({ answers: {} });
    expect(denialResponseForRequest('item/tool/requestUserInput')).toEqual({ answers: {} });
    expect(() => codexUserInputResponse(tool, { allow: true })).toThrow('structured answers');
    expect(() =>
      codexUserInputResponse(tool, {
        allow: true,
        response: {
          type: 'ask-user-question-response',
          outcome: 'answered',
          answers: [{ questionId: 'mode', selectedOptionIds: ['unknown'] }],
        },
      }),
    ).toThrow('unknown option');
  });
  it('rejects malformed, duplicate, and unanswerable requests', () => {
    for (const raw of [
      null,
      [],
      [questions[0], questions[0]],
      [{ ...questions[0], id: '' }],
      [{ ...questions[0], options: [], isOther: false }],
      [{ ...questions[0], options: [{}] }],
    ]) {
      expect(() => codexUserInputMessage(at, 'call', raw)).toThrow();
    }
    expect(
      codexUserInputMessage(at, 'call', [{ ...questions[0], options: null, isSecret: true }]).questions[0],
    ).toMatchObject({ options: [], allowFreeText: true, isSecret: true });
  });

  it('preserves valid IDs exactly and enforces the shared UTF-8 bound', () => {
    for (const id of [
      '  mode  ',
      'x'.repeat(ASK_USER_QUESTION_ID_MAX_BYTES),
      '\u00e9'.repeat(ASK_USER_QUESTION_ID_MAX_BYTES / 2),
    ]) {
      const message = codexUserInputMessage(at, 'call', [{ ...questions[0], id }]);
      expect(message.questions[0].id).toBe(id);
    }
    for (const id of [
      null,
      1,
      '',
      '   ',
      '\ud800',
      'x'.repeat(ASK_USER_QUESTION_ID_MAX_BYTES + 1),
      '\u00e9'.repeat(ASK_USER_QUESTION_ID_MAX_BYTES / 2 + 1),
    ]) {
      expect(() => codexUserInputMessage(at, 'call', [{ ...questions[0], id }]))
        .toThrow('Invalid Codex question');
    }
  });

  it('delivers option notes in the native TUI encoding without trimming', () => {
    const text = '  Only tests\nKeep defaults.  ';
    expect(codexUserInputResponse(tool, {
      allow: true,
      response: { type: 'ask-user-question-response', outcome: 'answered',
        answers: [{ questionId: 'mode', selectedOptionIds: ['option-1'], text }] },
    })).toEqual({ answers: { mode: { answers: ['Careful', `user_note: ${text}`] } } });
    expect(() => codexUserInputResponse(tool, {
      allow: true,
      response: { type: 'ask-user-question-response', outcome: 'answered',
        answers: [{ questionId: 'mode', selectedOptionIds: ['missing'], text }] },
    })).toThrow('unknown option');
  });

  it.each([
    { values: ['Careful', 'user_note:  Only tests\n '], answers: ['Careful'], text: ' Only tests\n ' },
    { values: ['None of the above', 'user_note: Custom'], answers: [], text: 'Custom' },
    { values: ['user_note: literal text'], answers: ['user_note: literal text'], text: undefined },
    { values: ['Unknown', 'user_note: literal text'], answers: ['Unknown', 'user_note: literal text'], text: undefined },
  ])('normalizes TUI notes without reinterpreting unrelated text: $values', ({ values, answers, text }) => {
    expect(codexHistoricalQuestionResult({ answers: { mode: { answers: values } } }, tool.questions))
      .toEqual({ answers: { mode: answers }, textAnswers: text === undefined ? {} : { mode: text } });
  });

  it('keeps real options named like Other and prototype-like question IDs', () => {
    const questions = [{ id: '__proto__', prompt: 'Pick one', options: [{ id: 'option-0', label: 'None of the above' }] }];
    const raw = { answers: Object.fromEntries([['__proto__', { answers: ['None of the above', 'user_note: note'] }]]) };
    const result = codexHistoricalQuestionResult(raw, questions)!;
    expect(Object.hasOwn(result.answers, '__proto__')).toBe(true);
    expect(result.answers.__proto__).toEqual(['None of the above']);
    expect(Object.hasOwn(result.textAnswers, '__proto__')).toBe(true);
    expect(result.textAnswers.__proto__).toBe('note');
    expect(Object.getPrototypeOf(result.textAnswers)).toBe(Object.prototype);
  });
  it('normalizes raw historical arguments and results without pending capabilities', () => {
    expect(
      codexHistoricalUserInput(at, 'call', { questions: [{ ...questions[0], isOther: undefined }] }).questions[0]
        .allowFreeText,
    ).toBe(true);
    expect(codexHistoricalQuestionResult('{"answers":{"mode":{"answers":["Custom"]}}}', tool.questions))
      .toEqual({ answers: { mode: ['Custom'] }, textAnswers: {} });
    expect(codexHistoricalQuestionResult('{"answers":{}}', tool.questions))
      .toEqual({ answers: {}, textAnswers: {} });
    expect(codexHistoricalQuestionResult('{"answers":{"mode":false}}', tool.questions)).toBeNull();
  });

  it('preserves arbitrary historical question IDs and exact answer arrays', () => {
    const nativeAnswers = Object.fromEntries([
      ['__proto__', { answers: ['  Custom\nmode  '] }],
      ['constructor', { answers: [] }],
    ]);
    const answers = codexHistoricalQuestionResult({ answers: nativeAnswers }, tool.questions)!.answers;
    expect(answers).toEqual(Object.fromEntries([
      ['__proto__', ['  Custom\nmode  ']],
      ['constructor', []],
    ]));
    expect(Object.getPrototypeOf(answers)).toBe(Object.prototype);
    expect(answers.__proto__).toBe(nativeAnswers.__proto__.answers);
  });

  it('rejects the whole historical answer map when any entry is malformed', () => {
    for (const invalid of [null, {}, { answers: 'Custom' }, { answers: ['Custom', 1] }]) {
      expect(codexHistoricalQuestionResult({
        answers: { valid: { answers: ['Fast'] }, invalid },
      }, tool.questions)).toBeNull();
    }
  });
});
