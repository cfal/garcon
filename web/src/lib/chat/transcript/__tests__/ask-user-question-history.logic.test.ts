import { describe, expect, it } from 'vitest';
import { AskUserQuestionToolUseMessage, ToolResultMessage } from '$shared/chat-types';
import { historicalAskUserQuestion } from '../ask-user-question-history.js';

const TS = '2026-08-13T00:00:00.000Z';

function question(): AskUserQuestionToolUseMessage {
	return new AskUserQuestionToolUseMessage(TS, 'question-1', undefined, [
		{
			id: 'mode',
			prompt: 'Which mode?',
			header: 'Mode',
			allowMultiple: false,
			options: [
				{ id: 'fast', label: 'Fast', description: 'Quick path.' },
				{ id: 'careful', label: 'Careful', description: 'Detailed path.' },
			],
		},
	]);
}

describe('historicalAskUserQuestion', () => {
	it('reconstructs exact selected option ids from structured result metadata', () => {
		const reconstructed = historicalAskUserQuestion(
			question(),
			new ToolResultMessage(
				TS,
				'question-1',
				{ toolUseResult: { answers: { mode: 'Careful' } } },
				false,
			),
		);

		expect(reconstructed.request.permissionOccurrenceId).toBe('ask-user-question-question-1');
		expect(reconstructed.terminal).toEqual({
			state: 'resolved',
			allowed: true,
			permissionOccurrenceId: 'ask-user-question-question-1',
			selectedQuestionOptions: { mode: ['careful'] },
		});
	});

	it('reconstructs a skipped question from an empty structured answer map', () => {
		const reconstructed = historicalAskUserQuestion(
			question(),
			new ToolResultMessage(
				TS,
				'question-1',
				{
					raw: 'The user did not answer the questions.',
					toolUseResult: { answers: {} },
				},
				false,
			),
		);

		expect(reconstructed.terminal).toEqual({
			state: 'resolved',
			allowed: false,
			permissionOccurrenceId: 'ask-user-question-question-1',
			reason: 'The user did not answer the questions.',
		});
	});
});
