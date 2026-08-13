import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import {
	AskUserQuestionToolUseMessage,
	ExitPlanModeToolUseMessage,
	ToolResultMessage,
	UserMessage,
} from '$shared/chat-types';
import ConversationTranscriptTestHost from './ConversationTranscriptTestHost.svelte';

describe('ConversationTranscript', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
	});

	it('binds durable and pending row identities to rendered message roots', () => {
		const rows: ChatDisplayRow[] = [
			{
				kind: 'message',
				id: 'generation-1:1',
				seq: 1,
				message: new UserMessage('2026-07-22T00:00:00.000Z', 'Durable message'),
			},
			{
				kind: 'message',
				id: 'pending:request-1',
				message: new UserMessage('2026-07-22T00:00:01.000Z', 'Pending message'),
			},
		];

		const { container } = render(ConversationTranscriptTestHost, { rows });

		expect(
			Array.from(
				container.querySelectorAll<HTMLElement>('[data-chat-row-id]'),
				(row) => row.dataset.chatRowId,
			),
		).toEqual(['generation-1:1', 'pending:request-1']);
		expect(
			Array.from(
				container.querySelectorAll<HTMLElement>('[data-chat-anchor-id]'),
				(row) => row.dataset.chatAnchorId,
			),
		).toEqual(['generation-1:1']);
	});

	it('renders answered historical questions from their canonical result row', () => {
		const timestamp = '2026-07-22T00:00:00.000Z';
		const rows: ChatDisplayRow[] = [
			{
				kind: 'message',
				id: 'generation-1:1',
				seq: 1,
				message: new AskUserQuestionToolUseMessage(timestamp, 'question-1', undefined, [
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
				]),
			},
			{
				kind: 'message',
				id: 'generation-1:2',
				seq: 2,
				message: new ToolResultMessage(
					timestamp,
					'question-1',
					{ toolUseResult: { answers: { mode: 'Careful' } } },
					false,
				),
			},
		];

		const { container, getByRole, getByText } = render(ConversationTranscriptTestHost, { rows });

		expect(getByText('Which mode?')).toBeTruthy();
		expect(getByText('Question answered')).toBeTruthy();
		expect((getByRole('radio', { name: /Careful/ }) as HTMLInputElement).checked).toBe(true);
		expect(container.querySelector('[data-chat-row-id="generation-1:2"]')).toBeTruthy();
	});

	it('renders a completed exit plan from its canonical tool row', () => {
		const rows: ChatDisplayRow[] = [
			{
				kind: 'message',
				id: 'generation-1:1',
				seq: 1,
				message: new ExitPlanModeToolUseMessage(
					'2026-07-22T00:00:00.000Z',
					'plan-1',
					'Implement carefully.',
				),
			},
		];

		const { getByText } = render(ConversationTranscriptTestHost, { rows });

		expect(getByText('Implement carefully.')).toBeTruthy();
		expect(getByText('Plan approved')).toBeTruthy();
	});
});
