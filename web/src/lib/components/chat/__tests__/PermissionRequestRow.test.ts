import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskUserQuestionToolUseMessage, PermissionRequestMessage } from '$shared/chat-types';
import PermissionRequestRowTestHost from './PermissionRequestRowTestHost.svelte';

const TS = '2026-07-02T00:00:00.000Z';

describe('PermissionRequestRow', () => {
	afterEach(() => {
		cleanup();
	});

	it('submits generic ask-user-question answers as canonical permission responses', async () => {
		const onDecision = vi.fn();
		const request = new PermissionRequestMessage(
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
});
