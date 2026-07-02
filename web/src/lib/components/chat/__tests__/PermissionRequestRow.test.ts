import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskUserQuestionToolUseMessage, PermissionRequestMessage } from '$shared/chat-types';
import PermissionRequestRowTestHost from './PermissionRequestRowTestHost.svelte';

const TS = '2026-07-02T00:00:00.000Z';

function askUserQuestionRequest(): PermissionRequestMessage {
	return new PermissionRequestMessage(
		TS,
		'perm-question',
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

		expect(onDecision).toHaveBeenCalledWith('perm-question', {
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
});
