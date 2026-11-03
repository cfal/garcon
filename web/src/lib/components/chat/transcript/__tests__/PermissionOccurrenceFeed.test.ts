import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PermissionOccurrenceFeedTestHost from './PermissionOccurrenceFeedTestHost.svelte';

describe('permission occurrence feed rendering', () => {
	afterEach(() => {
		cleanup();
	});

	it('retains independently typed notes and Other text through controlled row remounts', async () => {
		const onDecision = vi.fn();
		const { rerender } = render(PermissionOccurrenceFeedTestHost, {
			onDecision, questionOverrides: { allowFreeText: true, allowNotes: true },
		});
		const occurrences = screen.getAllByTestId('permission-occurrence');
		const first = within(occurrences[0]);
		const second = within(occurrences[1]);
		await fireEvent.click(first.getByRole('radio', { name: /First careful/ }));
		await fireEvent.input(first.getByRole('textbox', { name: 'Notes (optional)' }), {
			target: { value: '  First note\nKeep defaults.  ' },
		});
		await fireEvent.click(second.getByRole('radio', { name: 'Other' }));
		await fireEvent.input(second.getByRole('textbox', { name: 'Second mode?' }), {
			target: { value: '  Second custom answer  ' },
		});
		await rerender({ mounted: false });
		expect(screen.queryAllByTestId('permission-occurrence')).toEqual([]);
		await rerender({ mounted: true });
		const remounted = screen.getAllByTestId('permission-occurrence');
		expect(remounted[0]).not.toBe(occurrences[0]);
		const restoredFirst = within(remounted[0]);
		const restoredSecond = within(remounted[1]);
		expect(restoredFirst.getByRole<HTMLInputElement>('radio', { name: /First careful/ }).checked).toBe(true);
		expect(restoredFirst.getByRole<HTMLTextAreaElement>('textbox').value).toBe('  First note\nKeep defaults.  ');
		expect(restoredSecond.getByRole<HTMLInputElement>('radio', { name: 'Other' }).checked).toBe(true);
		expect(restoredSecond.getByRole<HTMLInputElement>('textbox').value).toBe('  Second custom answer  ');
		await fireEvent.click(restoredFirst.getByRole('button', { name: /submit answer/i }));
		await fireEvent.click(restoredSecond.getByRole('button', { name: /submit answer/i }));
		expect(onDecision.mock.calls).toEqual([
			['occurrence-one', { allow: true, response: { type: 'ask-user-question-response', outcome: 'answered',
				answers: [{ questionId: 'First mode?', selectedOptionIds: ['First careful'], text: '  First note\nKeep defaults.  ' }] } }],
			['occurrence-two', { allow: true, response: { type: 'ask-user-question-response', outcome: 'answered',
				answers: [{ questionId: 'Second mode?', selectedOptionIds: [], text: '  Second custom answer  ' }] } }],
		]);
	});

	it('keeps permission occurrences mounted, editable, and actionable independently', async () => {
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
		expect(onDecision).toHaveBeenCalledWith('occurrence-two', {
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
