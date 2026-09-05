import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AskUserQuestionToolUseMessage,
	ExitPlanModeToolUseMessage,
	PermissionRequestMessage,
} from '$shared/chat-types';
import PermissionRequestRowTestHost from './PermissionRequestRowTestHost.svelte';

const TS = '2026-07-02T00:00:00.000Z';

function askUserQuestionRequest(): PermissionRequestMessage {
	return new PermissionRequestMessage(
		TS,
		'incarnation-question',
		new AskUserQuestionToolUseMessage(TS, 'tool-question', undefined, [
			{
				id: 'Which mode?',
				prompt: 'Which mode?',
				header: 'Mode',
				options: [
					{ id: 'Fast', label: 'Fast', description: 'Quick path.' },
					{
						id: 'Careful',
						label: 'Careful',
						description: 'Detailed path.',
						preview: '<pre>careful</pre>',
					},
				],
				allowMultiple: false,
			},
		]),
	);
}

describe('PermissionRequestRow', () => {
	afterEach(() => {
		cleanup();
	});

	it('submits generic ask-user-question answers as canonical permission responses', async () => {
		const onDecision = vi.fn();
		const request = askUserQuestionRequest();

		render(PermissionRequestRowTestHost, { request, onDecision });

		const submit = screen.getByRole('button', { name: /submit answer/i }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		expect(screen.getByText('Mode')).toBeTruthy();
		expect(screen.getByText('Which mode?')).toBeTruthy();

		await fireEvent.click(screen.getByRole('radio', { name: /Careful/ }));

		expect(submit.disabled).toBe(false);
		expect(screen.getByText('<pre>careful</pre>')).toBeTruthy();

		await fireEvent.click(submit);

		expect(onDecision).toHaveBeenCalledWith('incarnation-question', {
			allow: true,
			response: {
				type: 'ask-user-question-response',
				outcome: 'answered',
				answers: [{ questionId: 'Which mode?', selectedOptionIds: ['Careful'] }],
			},
		});
	});

	it('renders resolved generic ask-user-question answers as selected read-only options', () => {
		const onDecision = vi.fn();
		const request = askUserQuestionRequest();

		render(PermissionRequestRowTestHost, {
			request,
			onDecision,
			terminal: {
				permissionOccurrenceId: 'incarnation-question',
				state: 'resolved',
				allowed: true,
				selectedQuestionOptions: { 'Which mode?': ['Careful'] },
			},
		});

		const fast = screen.getByRole('radio', { name: /Fast/ }) as HTMLInputElement;
		const careful = screen.getByRole('radio', { name: /Careful/ }) as HTMLInputElement;

		expect(screen.getByText('Question answered')).toBeTruthy();
		expect(fast.checked).toBe(false);
		expect(careful.checked).toBe(true);
		expect(fast.disabled).toBe(true);
		expect(careful.disabled).toBe(true);
		expect(screen.queryByRole('button', { name: /submit answer/i })).toBeNull();
		expect(onDecision).not.toHaveBeenCalled();
	});

	it('renders skipped generic ask-user-question history as read-only unanswered options', () => {
		const onDecision = vi.fn();
		const request = askUserQuestionRequest();

		render(PermissionRequestRowTestHost, {
			request,
			onDecision,
			terminal: {
				permissionOccurrenceId: 'incarnation-question',
				state: 'resolved',
				allowed: false,
				reason: 'The user did not answer the questions.',
			},
		});

		const fast = screen.getByRole('radio', { name: /Fast/ }) as HTMLInputElement;
		const careful = screen.getByRole('radio', { name: /Careful/ }) as HTMLInputElement;

		expect(screen.getByText('Question skipped')).toBeTruthy();
		expect(fast.checked).toBe(false);
		expect(careful.checked).toBe(false);
		expect(fast.disabled).toBe(true);
		expect(careful.disabled).toBe(true);
		expect(screen.queryByRole('button', { name: /skip/i })).toBeNull();
		expect(onDecision).not.toHaveBeenCalled();
	});

	it('reports immutable controlled drafts without losing the caller-owned value', async () => {
		const onDraftChange = vi.fn();
		const draft = { selectedQuestionOptions: {}, rawInputOpen: false };
		render(PermissionRequestRowTestHost, {
			request: askUserQuestionRequest(),
			onDecision: vi.fn(),
			draft,
			onDraftChange,
		});

		await fireEvent.click(screen.getByRole('radio', { name: /Careful/ }));
		expect(onDraftChange).toHaveBeenCalledWith({
			selectedQuestionOptions: { 'Which mode?': ['Careful'] },
			rawInputOpen: false,
		});
		expect(draft).toEqual({ selectedQuestionOptions: {}, rawInputOpen: false });
	});

	it('resolves explicit chat links without autolinking bare IDs in permission plans', () => {
		const chatId = '1788592720180699';
		const request = new PermissionRequestMessage(
			TS,
			'incarnation-plan',
			new ExitPlanModeToolUseMessage(TS, 'tool-plan', `${chatId} [Open target](/chat/${chatId})`),
		);
		const { container } = render(PermissionRequestRowTestHost, {
			request,
			onDecision: vi.fn(),
			chatTitles: { [chatId]: 'Target chat' },
			chatContext: { chatId: 'chat-1', projectPath: '/workspace/project' },
		});

		expect(screen.getByRole('link', { name: 'Open target' })).toBeTruthy();
		expect(container.querySelectorAll('[data-chat-reference-id]')).toHaveLength(1);
	});
});
