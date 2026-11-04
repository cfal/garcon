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
	it.each([
		['Fast, but only for tests'],
		['Fast', 'Custom\nconstraint'],
		[' Fast '],
		['fast'],
	])('preserves complete free-text answers without partial option matches: %j', (...answers) => {
		const tool = question();
		tool.questions[0].allowFreeText = true;
		const reconstructed = historicalAskUserQuestion(tool, new ToolResultMessage(TS, tool.toolId,
			{ toolUseResult: { answers: { mode: answers } } }, false));
		expect(reconstructed.terminal.selectedQuestionOptions).toEqual({});
		expect(reconstructed.terminal.questionTextAnswers).toEqual({ mode: answers.join('\n') });
	});

	it('preserves text matching a synthetic option ID rather than a native label', () => {
		const tool = question();
		tool.questions[0].allowFreeText = true;
		tool.questions[0].options = [{ id: 'option-0', label: 'Fast' }];
		const result = new ToolResultMessage(TS, tool.toolId, {
			toolUseResult: { answers: { mode: ['option-0'] } },
		}, false);
		const terminal = historicalAskUserQuestion(tool, result).terminal;
		expect(terminal.selectedQuestionOptions).toEqual({});
		expect(terminal.questionTextAnswers).toEqual({ mode: 'option-0' });
	});

	it('recognizes complete option labels on free-text questions', () => {
		const tool = question();
		tool.questions[0].allowFreeText = true;
		const reconstructed = historicalAskUserQuestion(tool, new ToolResultMessage(TS, tool.toolId,
			{ toolUseResult: { answers: { mode: ['Fast'] } } }, false));
		expect(reconstructed.terminal.selectedQuestionOptions).toEqual({ mode: ['fast'] });
		expect(reconstructed.terminal.questionTextAnswers).toEqual({});
	});

	it.each([
		{ allowFreeText: true, expectedId: 'option-1' },
		{ allowFreeText: false, expectedId: 'option-0' },
	])('disambiguates labels and IDs for allowFreeText=$allowFreeText', ({ allowFreeText, expectedId }) => {
		const tool = question();
		tool.questions[0].allowFreeText = allowFreeText;
		tool.questions[0].options = [
			{ id: 'option-0', label: 'Fast' },
			{ id: 'option-1', label: 'option-0' },
		];
		const result = new ToolResultMessage(TS, tool.toolId, {
			toolUseResult: { answers: { mode: ['option-0'] } },
		}, false);
		expect(historicalAskUserQuestion(tool, result).terminal.selectedQuestionOptions)
			.toEqual({ mode: [expectedId] });
	});

	it.each(['structured', 'legacy'])('preserves prototype-like IDs in %s answer maps', (format) => {
		const tool = question();
		tool.questions[0].id = '__proto__';
		const content = format === 'structured'
			? { toolUseResult: { answers: { ['__proto__']: ['Careful'] } } }
			: { raw: 'User answered: "Which mode?"="Careful"' };
		const result = new ToolResultMessage(TS, tool.toolId, content, false);
		const selected = historicalAskUserQuestion(tool, result).terminal.selectedQuestionOptions;
		expect(selected).toStrictEqual({ ['__proto__']: ['careful'] });
		expect(Object.getPrototypeOf(selected)).toBe(Object.prototype);
	});

	it.each(['__proto__', 'constructor', 'toString'])('uses own prompt answers when ID %s is absent', (id) => {
		const tool = question();
		tool.questions[0].id = id;
		const result = new ToolResultMessage(TS, tool.toolId, {
			toolUseResult: { answers: { 'Which mode?': 'Careful' } },
		}, false);
		const selected = historicalAskUserQuestion(tool, result).terminal.selectedQuestionOptions;
		expect(Object.keys(selected ?? {})).toEqual([id]);
		expect(selected?.[id]).toEqual(['careful']);
		expect(Object.getPrototypeOf(selected)).toBe(Object.prototype);
	});

	it('retains comma-separated legacy selections for option-only questions', () => {
		const tool = question();
		const reconstructed = historicalAskUserQuestion(tool, new ToolResultMessage(TS, tool.toolId,
			{ toolUseResult: { answers: { mode: 'Fast, Careful' } } }, false));
		expect(reconstructed.terminal.selectedQuestionOptions).toEqual({ mode: ['fast', 'careful'] });
	});

	it.each([
		{ allowFreeText: true, answers: ['Careful', 'Fast', 'Careful'] },
		{ allowFreeText: false, answers: ['careful', 'Unknown', 'Fast, Careful', 'fast'] },
	])('keeps the first selection order while deduplicating, allowFreeText=$allowFreeText', ({ allowFreeText, answers }) => {
		const tool = question();
		tool.questions[0].allowFreeText = allowFreeText;
		const result = new ToolResultMessage(TS, tool.toolId, {
			toolUseResult: { answers: { mode: answers } },
		}, false);
		expect(historicalAskUserQuestion(tool, result).terminal.selectedQuestionOptions)
			.toEqual({ mode: ['careful', 'fast'] });
	});

	it('keeps failed question results unanswered with their reason', () => {
		const reason = 'request_user_input is unavailable in Default mode';
		const reconstructed = historicalAskUserQuestion(question(), new ToolResultMessage(TS, 'question-1', { raw: reason }, true));
		expect(reconstructed.terminal).toMatchObject({ allowed: false, reason });
	});

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
			questionTextAnswers: {},
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
