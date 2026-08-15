import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PermissionOccurrenceFeedTestHost from './PermissionOccurrenceFeedTestHost.svelte';

describe('permission occurrence feed rendering', () => {
	afterEach(() => {
		cleanup();
	});

	it('keeps equal request ids mounted, editable, and actionable as separate occurrences', async () => {
		const onDecision = vi.fn();
		render(PermissionOccurrenceFeedTestHost, { onDecision });

		const occurrences = screen.getAllByTestId('permission-occurrence');
		expect(occurrences).toHaveLength(2);
		expect(new Set(occurrences.map((row) => row.dataset.virtualKey)).size).toBe(2);

		const first = within(occurrences[0]);
		const second = within(occurrences[1]);
		const firstCareful = first.getByRole('radio', { name: /First careful/ }) as HTMLInputElement;
		const secondCareful = second.getByRole('radio', { name: /Second careful/ }) as HTMLInputElement;

		await fireEvent.click(firstCareful);
		expect(firstCareful.checked).toBe(true);
		expect(secondCareful.checked).toBe(false);

		await fireEvent.click(secondCareful);
		expect(firstCareful.checked).toBe(true);
		expect(secondCareful.checked).toBe(true);

		await fireEvent.click(second.getByRole('button', { name: /submit answer/i }));
		expect(onDecision).toHaveBeenCalledOnce();
		expect(onDecision).toHaveBeenCalledWith('reused-permission', 'occurrence-two', {
			allow: true,
			response: {
				type: 'ask-user-question-response',
				outcome: 'answered',
				answers: [
					{
						questionId: 'Second mode?',
						selectedOptionIds: ['Second careful'],
					},
				],
			},
		});
	});
});
