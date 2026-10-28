import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import ResendCandidateChips from '../ResendCandidateChips.svelte';

it('exposes the appearance hook without changing resend exclusion', async () => {
	const onExclude = vi.fn();
	render(ResendCandidateChips, {
		candidates: [{ ordinal: 1, content: 'Synthetic pending input', attachmentNames: [] }],
		onExclude,
	});
	const chip = screen.getByText('Synthetic pending input').parentElement;
	expect(chip?.getAttribute('data-slot')).toBe('composer-resend-candidate');
	expect(chip?.classList.contains('rounded-md')).toBe(true);
	await fireEvent.click(screen.getByRole('button'));
	expect(onExclude).toHaveBeenCalledWith(1);
});
