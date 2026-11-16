import { describe, expect, it } from 'vitest';
import {
	AgentSwitchMessage,
	AskUserQuestionToolUseMessage,
	AssistantMessage,
	BashToolUseMessage,
	ThinkingMessage,
	ToolResultMessage,
	TranscriptNoticeMessage,
	UserMessage,
	type ChatMessage,
} from '$shared/chat-types';
import type { AsyncQuestionReply, AsyncQuestionSet } from '$shared/async-user-questions';
import type { TranscriptMessage } from '$shared/chat-view';
import type { PendingPermissionRequest } from '$lib/types/chat';
import {
	composerQuestion,
	composerQuestionKey,
	type ComposerQuestion,
} from '$lib/chat/composer/composer-question.js';

const TS = '2026-01-01T00:00:00.000Z';
const PLAIN_QUESTION = 'Which layout do you prefer?\n- Compact\n- Spacious';
const IDLE = { isProcessing: false, hasLaterMessages: false };
const TARGET = { ...IDLE, chatId: 'chat-a', transcriptViewId: 'view-a' };
const ASYNC_QUESTIONS = {
	id: 'question-set-1',
	questions: [
		{
			id: 'layout',
			prompt: 'Which layout do you prefer?',
			options: [
				{ id: 'compact', label: 'Compact' },
				{ id: 'spacious', label: 'Spacious' },
			],
			allowFreeText: true,
		},
	],
} satisfies AsyncQuestionSet;

function row(message: ChatMessage, ordinal = 1): TranscriptMessage {
	return { ordinal, message };
}

function questionReply(source: Partial<NonNullable<AsyncQuestionReply['source']>> = {}) {
	return new UserMessage(TS, 'Compact', undefined, {
		questionReply: {
			questionId: 'layout',
			question: 'Which layout do you prefer?',
			answer: 'Compact',
			source: { chatId: 'chat-a', transcriptViewId: 'view-a', ordinal: 1, ...source },
		},
	});
}

function pendingQuestion(permissionOccurrenceId = 'permission-1') {
	return {
		permissionOccurrenceId,
		requestedTool: new AskUserQuestionToolUseMessage(TS, 'question-tool-1', undefined, [
			{
				id: 'layout',
				prompt: 'Which layout do you prefer?',
				options: [
					{ id: 'compact', label: 'Compact' },
					{ id: 'spacious', label: 'Spacious' },
				],
			},
		]),
	} satisfies PendingPermissionRequest;
}

function requiredQuestion(entries: readonly TranscriptMessage[]): ComposerQuestion {
	const result = composerQuestion(entries, [], IDLE);
	if (!result) throw new Error('Expected a composer question in the synthetic transcript');
	return result;
}

describe('composerQuestion', () => {
	it('prioritizes a pending question permission while processing or viewing older messages', () => {
		const request = pendingQuestion();
		const entries = [row(new AssistantMessage(TS, PLAIN_QUESTION, ASYNC_QUESTIONS))];
		expect(
			composerQuestion(entries, [request], { isProcessing: true, hasLaterMessages: true }),
		).toEqual({ kind: 'permission', request });
	});

	it('skips other permission tools and chooses the first pending question occurrence', () => {
		const shell = {
			permissionOccurrenceId: 'shell-permission',
			requestedTool: new BashToolUseMessage(TS, 'shell-tool', 'echo synthetic'),
		} satisfies PendingPermissionRequest;
		const first = pendingQuestion('first-question');
		expect(composerQuestion([], [shell, first, pendingQuestion('second-question')], IDLE)).toEqual({
			kind: 'permission',
			request: first,
		});
		expect(composerQuestion([], [shell], IDLE)).toBeNull();
	});

	it('offers structured async questions before parsing plain text and while processing', () => {
		const message = new AssistantMessage(TS, PLAIN_QUESTION, ASYNC_QUESTIONS);
		expect(composerQuestion([row(message, 7)], [], { ...IDLE, isProcessing: true })).toEqual({
			kind: 'async',
			ordinal: 7,
			message,
		});
		expect(composerQuestion([row(message, 7)], [], IDLE)?.kind).toBe('async');
	});

	it('offers plain choices only after the turn has completed', () => {
		const entries = [row(new AssistantMessage(TS, PLAIN_QUESTION), 5)];
		expect(composerQuestion(entries, [], { ...IDLE, isProcessing: true })).toBeNull();
		expect(composerQuestion(entries, [], IDLE)).toMatchObject({
			kind: 'plain',
			sources: [{ ordinal: 5 }],
			questions: [{ prompt: 'Which layout do you prefer?' }],
		});
	});

	it.each([
		new AssistantMessage(TS, PLAIN_QUESTION),
		new AssistantMessage(TS, 'Structured question.', ASYNC_QUESTIONS),
	])('does not offer a question from a historical transcript window: $content', (message) => {
		expect(composerQuestion([row(message)], [], { ...IDLE, hasLaterMessages: true })).toBeNull();
	});

	it.each([
		new UserMessage(TS, 'Compact'),
		new AgentSwitchMessage(TS, 'synthetic-agent-a', 'synthetic-agent-b'),
	])('does not revive an old question across a later $type', (message) => {
		for (const question of [
			new AssistantMessage(TS, PLAIN_QUESTION),
			new AssistantMessage(TS, 'Structured question.', ASYNC_QUESTIONS),
		]) {
			expect(composerQuestion([row(question), row(message, 2)], [], IDLE)).toBeNull();
		}
	});

	it('keeps structured questions through ordinary assistant continuation text', () => {
		const message = new AssistantMessage(TS, 'Structured question.', ASYNC_QUESTIONS);
		const entries = [row(message), row(new AssistantMessage(TS, 'Synthetic continuation.'), 2)];
		for (const isProcessing of [false, true]) {
			expect(composerQuestion(entries, [], { ...IDLE, isProcessing })).toEqual({
				kind: 'async',
				ordinal: 1,
				message,
			});
		}
		expect(
			composerQuestion([row(new AssistantMessage(TS, PLAIN_QUESTION)), entries[1]], [], IDLE),
		).toBeNull();
	});

	it('finds plain choices before a separate selection-reminder block', () => {
		const entries = [
			row(new AssistantMessage(TS, 'Pick a sample review format.'), 2),
			row(
				new AssistantMessage(
					TS,
					'How would you most like to review a sample?\n- Outline\n- Diagram\n- Example',
				),
				3,
			),
			row(new AssistantMessage(TS, 'Choose an option above, or type your own answer.'), 4),
		];
		expect(composerQuestion(entries, [], IDLE)).toMatchObject({
			kind: 'plain',
			sources: [{ ordinal: 3 }],
			questions: [{
				prompt: 'How would you most like to review a sample?',
				options: [
					{ id: 'option-1', label: 'Outline' },
					{ id: 'option-2', label: 'Diagram' },
					{ id: 'option-3', label: 'Example' },
				],
			}],
		});
		expect(composerQuestion(entries, [], { ...IDLE, isProcessing: true })).toBeNull();
	});

	it.each([
		new UserMessage(TS, 'Synthetic new request.'),
		new AgentSwitchMessage(TS, 'synthetic-agent-a', 'synthetic-agent-b'),
		new AssistantMessage(TS, 'Synthetic unrelated continuation.'),
	])('does not cross a $type boundary before a choice reminder', (boundary) => {
		expect(
			composerQuestion(
				[
					row(new AssistantMessage(TS, PLAIN_QUESTION)),
					row(boundary, 2),
					row(new AssistantMessage(TS, 'Choose an option above, or type your own answer.'), 3),
				],
				[],
				IDLE,
			),
		).toBeNull();
	});

	it('replaces an earlier question with the latest assistant question', () => {
		const result = composerQuestion(
			[
				row(new AssistantMessage(TS, 'Structured question.', ASYNC_QUESTIONS)),
				row(new AssistantMessage(TS, 'Which theme do you prefer?\n1. Light\n2. Dark'), 2),
			],
			[],
			IDLE,
		);
		expect(result).toMatchObject({
			kind: 'plain',
			sources: [{ ordinal: 2 }],
			questions: [{ prompt: 'Which theme do you prefer?' }],
		});
	});

	it('ignores housekeeping notices and tool rows after an assistant question', () => {
		const result = composerQuestion(
			[
				row(new AssistantMessage(TS, PLAIN_QUESTION)),
				row(new TranscriptNoticeMessage(TS, 'Synthetic turn completed.'), 2),
				row(new ThinkingMessage(TS, 'Synthetic internal status.'), 3),
				row(new ToolResultMessage(TS, 'synthetic-tool', { result: 'complete' }, false), 4),
			],
			[],
			IDLE,
		);
		expect(result).toMatchObject({ kind: 'plain', sources: [{ ordinal: 1 }] });
	});

	it('inspects at most the last 100 loaded rows', () => {
		const question = row(new AssistantMessage(TS, PLAIN_QUESTION));
		const notices = Array.from({ length: 100 }, (_, index) =>
			row(new TranscriptNoticeMessage(TS, 'Synthetic housekeeping.'), index + 2),
		);
		expect(composerQuestion([question, ...notices.slice(0, 99)], [], IDLE)?.kind).toBe('plain');
		expect(composerQuestion([question, ...notices], [], IDLE)).toBeNull();
	});

	it('returns no question for empty or non-question transcript content', () => {
		expect(composerQuestion([], [], IDLE)).toBeNull();
		expect(
			composerQuestion([row(new AssistantMessage(TS, 'Synthetic response.'))], [], IDLE),
		).toBeNull();
	});

	it('retains sibling async prompts after answering one question from the same source set', () => {
		const message = new AssistantMessage(TS, '', {
			...ASYNC_QUESTIONS,
			questions: [
				...ASYNC_QUESTIONS.questions,
				{
					id: 'theme',
					prompt: 'Which theme do you prefer?',
					options: [
						{ id: 'light', label: 'Light' },
						{ id: 'dark', label: 'Dark' },
					],
					allowFreeText: true,
				},
			],
		});
		expect(composerQuestion([row(message), row(questionReply(), 2)], [], TARGET)).toEqual({
			kind: 'async',
			ordinal: 1,
			message,
		});
	});

	it('retains the same async source through multiple matching replies and notices', () => {
		const message = new AssistantMessage(TS, '', ASYNC_QUESTIONS);
		expect(
			composerQuestion(
				[
					row(message),
					row(questionReply(), 2),
					row(new TranscriptNoticeMessage(TS, 'Synthetic notice.'), 3),
					row(questionReply(), 4),
				],
				[],
				TARGET,
			),
		).toEqual({ kind: 'async', ordinal: 1, message });
	});

	it.each([{ chatId: 'chat-b' }, { transcriptViewId: 'view-b' }, { ordinal: 2 }])(
		'does not cross a reply from a different source: %o',
		(source) => {
			expect(
				composerQuestion(
					[row(new AssistantMessage(TS, '', ASYNC_QUESTIONS)), row(questionReply(source), 3)],
					[],
					TARGET,
				),
			).toBeNull();
		},
	);

	it('requires a current chat and view before crossing question replies', () => {
		const entries = [row(new AssistantMessage(TS, '', ASYNC_QUESTIONS)), row(questionReply(), 2)];
		expect(composerQuestion(entries, [], IDLE)).toBeNull();
		expect(composerQuestion(entries, [], { ...IDLE, chatId: 'chat-a' })).toBeNull();
	});

	it('does not let reply metadata revive plain-text choices or unknown structured questions', () => {
		expect(
			composerQuestion(
				[row(new AssistantMessage(TS, PLAIN_QUESTION)), row(questionReply(), 2)],
				[],
				TARGET,
			),
		).toBeNull();
		const changedPrompt = new AssistantMessage(TS, '', {
			...ASYNC_QUESTIONS,
			questions: ASYNC_QUESTIONS.questions.map((question) => ({
				...question,
				prompt: 'A changed prompt?',
			})),
		});
		expect(composerQuestion([row(changedPrompt), row(questionReply(), 2)], [], TARGET)).toBeNull();
	});

	it.each([
		new UserMessage(TS, 'Synthetic ordinary request.'),
		new AgentSwitchMessage(TS, 'synthetic-agent-a', 'synthetic-agent-b'),
	])('does not skip an intervening $type while following a question reply', (boundary) => {
		expect(
			composerQuestion(
				[
					row(new AssistantMessage(TS, '', ASYNC_QUESTIONS)),
					row(boundary, 2),
					row(questionReply(), 3),
				],
				[],
				TARGET,
			),
		).toBeNull();
	});

	it('retains sibling questions across replies and later assistant continuation text', () => {
		const message = new AssistantMessage(TS, '', ASYNC_QUESTIONS);
		const continuation = new AssistantMessage(TS, 'Synthetic continuation.');
		for (const entries of [
			[row(message), row(questionReply(), 2), row(continuation, 3)],
			[row(message), row(continuation, 2), row(questionReply(), 3)],
		]) {
			expect(composerQuestion(entries, [], TARGET)).toEqual({ kind: 'async', ordinal: 1, message });
		}
	});

	it('does not cross a newer question while following a structured reply source', () => {
		expect(
			composerQuestion(
				[
					row(new AssistantMessage(TS, '', ASYNC_QUESTIONS)),
					row(new AssistantMessage(TS, 'Which theme do you prefer?\n1. Light\n2. Dark'), 2),
					row(questionReply(), 3),
				],
				[],
				TARGET,
			),
		).toBeNull();
	});

	it('collects adjacent question sources in transcript order with unique source-qualified IDs', () => {
		const result = composerQuestion([
			row(new AssistantMessage(TS, PLAIN_QUESTION), 3),
			row(new AssistantMessage(TS, 'Choose an option above.'), 4),
			row(new AssistantMessage(TS, 'Which theme do you prefer?\n- Light\n- Dark'), 5),
		], [], IDLE);
		expect(result).toMatchObject({
			kind: 'plain',
			questions: [{ id: '3:question-1', prompt: 'Which layout do you prefer?' }, { id: '5:question-1', prompt: 'Which theme do you prefer?' }],
			sources: [{ ordinal: 3, contentWithoutOptions: 'Which layout do you prefer?' }, { ordinal: 5, contentWithoutOptions: 'Which theme do you prefer?' }],
		});
	});

	it('retains multiple questions from one source before questions in an adjacent source', () => {
		const result = composerQuestion([
			row(new AssistantMessage(TS, `${PLAIN_QUESTION}\n\nWhich theme do you prefer?\n- Light\n- Dark`), 1),
			row(new AssistantMessage(TS, 'Which format do you prefer?\n- Outline\n- Diagram'), 2),
		], [], IDLE);
		if (result?.kind !== 'plain') throw new Error('Expected synthetic plain question set');
		expect(result.questions.map(question => question.id)).toEqual(['1:question-1', '1:question-2', '2:question-1']);
		expect(result.sources.map(source => source.ordinal)).toEqual([1, 2]);
	});

	it.each([
		new AssistantMessage(TS, 'Synthetic unrelated explanation.'),
		new UserMessage(TS, 'Synthetic new request.'),
		new AgentSwitchMessage(TS, 'synthetic-a', 'synthetic-b'),
	])('does not merge choices across an intervening $type boundary', (boundary) => {
		const result = composerQuestion([
			row(new AssistantMessage(TS, PLAIN_QUESTION)),
			row(boundary, 2),
			row(new AssistantMessage(TS, 'Which theme do you prefer?\n- Light\n- Dark'), 3),
		], [], IDLE);
		expect(result).toMatchObject({ kind: 'plain', questions: [{ id: '3:question-1' }], sources: [{ ordinal: 3 }] });
	});

	it('applies an explicit multi-select reminder to its preceding question source', () => {
		const result = composerQuestion([
			row(new AssistantMessage(TS, PLAIN_QUESTION)),
			row(new AssistantMessage(TS, 'Select all that apply.'), 2),
		], [], IDLE);
		expect(result).toMatchObject({ kind: 'plain', questions: [{ allowMultiple: true }] });
	});

	it.each(['Pick up to 3.', 'Choose up to 3 options.', 'Select exactly two answers.'])(
		'keeps capped split-row questions in their original transcript: %s', (reminder) => {
			expect(composerQuestion([
				row(new AssistantMessage(TS, 'Which features would you choose?\n- Outline\n- Diagram\n- Example\n- Preview')),
				row(new AssistantMessage(TS, reminder), 2),
			], [], IDLE)).toBeNull();
		},
	);

	it('bounds collected question sources and aggregate parsed content', () => {
		const many = Array.from({ length: 11 }, (_, index) => row(new AssistantMessage(TS, PLAIN_QUESTION), index + 1));
		const bounded = composerQuestion(many, [], IDLE);
		if (bounded?.kind !== 'plain') throw new Error('Expected bounded synthetic question set');
		expect(bounded.sources.map(source => source.ordinal)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		const long = `${'x'.repeat(9_000)}\n${PLAIN_QUESTION}`;
		const textBounded = composerQuestion([1, 2, 3].map(ordinal => row(new AssistantMessage(TS, long), ordinal)), [], IDLE);
		if (textBounded?.kind !== 'plain') throw new Error('Expected text-bounded synthetic question set');
		expect(textBounded.sources.map(source => source.ordinal)).toEqual([2, 3]);
	});
});

describe('composerQuestionKey', () => {
	it('qualifies plain question identity by chat, view, and source ordinal', () => {
		const question = requiredQuestion([row(new AssistantMessage(TS, PLAIN_QUESTION), 8)]);
		const nextOrdinal = requiredQuestion([row(new AssistantMessage(TS, PLAIN_QUESTION), 9)]);
		const key = composerQuestionKey(question, 'chat-a', 'view-a');
		expect(composerQuestionKey(question, 'chat-a', 'view-a')).toBe(key);
		expect(
			new Set([
				key,
				composerQuestionKey(question, 'chat-b', 'view-a'),
				composerQuestionKey(question, 'chat-a', 'view-b'),
				composerQuestionKey(nextOrdinal, 'chat-a', 'view-a'),
			]).size,
		).toBe(4);
	});

	it('qualifies permission identity by occurrence rather than the repeated tool ID', () => {
		const first = {
			kind: 'permission',
			request: pendingQuestion('occurrence-a'),
		} satisfies ComposerQuestion;
		const second = {
			kind: 'permission',
			request: pendingQuestion('occurrence-b'),
		} satisfies ComposerQuestion;
		expect(composerQuestionKey(first, 'chat-a', 'view-a')).not.toBe(
			composerQuestionKey(second, 'chat-a', 'view-a'),
		);
	});

	it('distinguishes structured and plain questions at the same ordinal', () => {
		const plain = requiredQuestion([row(new AssistantMessage(TS, PLAIN_QUESTION))]);
		const structured = requiredQuestion([
			row(new AssistantMessage(TS, PLAIN_QUESTION, ASYNC_QUESTIONS)),
		]);
		expect(composerQuestionKey(plain, 'chat-a', 'view-a')).not.toBe(
			composerQuestionKey(structured, 'chat-a', 'view-a'),
		);
	});

	it('includes every source ordinal rather than only the last question row', () => {
		const first = requiredQuestion([row(new AssistantMessage(TS, PLAIN_QUESTION), 1), row(new AssistantMessage(TS, PLAIN_QUESTION), 3)]);
		const second = requiredQuestion([row(new AssistantMessage(TS, PLAIN_QUESTION), 2), row(new AssistantMessage(TS, PLAIN_QUESTION), 3)]);
		expect(composerQuestionKey(first, 'chat-a', 'view-a')).not.toBe(composerQuestionKey(second, 'chat-a', 'view-a'));
	});
});
