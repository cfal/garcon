import { describe, expect, test } from 'vitest';
import { LegacyCodexProjection } from '../../../../../../server-agents/codex/src/agents/codex/legacy-history-projection.js';
import { codexUserInputResponse } from '../../../../../../server-agents/codex/src/agents/codex/user-input.js';
import { historicalAskUserQuestion } from '../ask-user-question-history.js';
import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';

function questionCall(callId: string) {
  return {
    type: 'function_call', name: 'request_user_input', call_id: callId,
    arguments: JSON.stringify({ questions: [{
      id: 'mode', header: 'Mode', question: 'Which mode?',
      options: [{ label: 'Fast' }, { label: 'Careful' }],
    }] }),
  };
}

describe('Codex question history round-trip', () => {
  function reconstruct(decision: PermissionDecisionPayload | string) {
    const projection = new LegacyCodexProjection();
    const timestamp = '2026-01-01T00:00:00.000Z';
    const tool = projection.project({
      type: 'response_item', timestamp, payload: questionCall('call-history'),
    }, {})?.canonical[0];
    if (tool?.type !== 'ask-user-question-tool-use') throw new Error('Expected question');
    const output = typeof decision === 'string'
      ? decision
      : JSON.stringify(codexUserInputResponse(tool, decision));
    const result = projection.project({
      type: 'response_item', timestamp,
      payload: { type: 'function_call_output', call_id: 'call-history', output },
    }, {})?.canonical[0];
    if (result?.type !== 'tool-result') throw new Error('Expected question result');
    return historicalAskUserQuestion(tool, result).terminal;
  }

  test.each(['option-0', 'option-1', 'request_user_input was cancelled'])(
    'preserves native free text verbatim: %s', (text) => {
      const terminal = reconstruct({ allow: true, response: {
        type: 'ask-user-question-response', outcome: 'answered',
        answers: [{ questionId: 'mode', selectedOptionIds: [], text }],
      } });
      expect(terminal.selectedQuestionOptions).toEqual({});
      expect(terminal.questionTextAnswers).toEqual({ mode: text });
    },
  );

  test('reconstructs selected options through native labels', () => {
    const terminal = reconstruct({ allow: true, response: {
      type: 'ask-user-question-response', outcome: 'answered',
      answers: [{ questionId: 'mode', selectedOptionIds: ['option-1'] }],
    } });
    expect(terminal.selectedQuestionOptions).toEqual({ mode: ['option-1'] });
    expect(terminal.questionTextAnswers).toEqual({});
  });

  test('shows a skipped native result without a raw JSON reason', () => {
    expect(reconstruct({ allow: false })).toMatchObject({ allowed: false, reason: 'User skipped question' });
  });

  test('round-trips selected options and notes without converting them to Other', () => {
    const text = '  Only tests\nKeep defaults.  ';
    const terminal = reconstruct({ allow: true, response: {
      type: 'ask-user-question-response', outcome: 'answered',
      answers: [{ questionId: 'mode', selectedOptionIds: ['option-1'], text }],
    } });
    expect(terminal.selectedQuestionOptions).toEqual({ mode: ['option-1'] });
    expect(terminal.questionTextAnswers).toEqual({ mode: text });
  });

  const tuiAnswers: { values: string[]; selected: Record<string, string[]>; text: string }[] = [
    { values: ['Careful', 'user_note: Only tests'], selected: { mode: ['option-1'] }, text: 'Only tests' },
    { values: ['None of the above', 'user_note: Fast'], selected: {}, text: 'Fast' },
  ];
  test.each(tuiAnswers)('imports TUI options and Other notes: $values', ({ values, selected, text }) => {
    const terminal = reconstruct(JSON.stringify({ answers: { mode: { answers: values } } }));
    expect(terminal.selectedQuestionOptions).toEqual(selected);
    expect(terminal.questionTextAnswers).toEqual({ mode: text });
  });

  test('shows a native argument failure as unanswered with its reason', () => {
    const reason = 'failed to parse function arguments: missing field `header`';
    expect(reconstruct(reason)).toMatchObject({ allowed: false, reason });
  });
});
