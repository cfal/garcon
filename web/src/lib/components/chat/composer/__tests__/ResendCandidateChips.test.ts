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

it('preserves full text and attachment-only filename labels', async () => {
	const content = `Synthetic ${'long input '.repeat(50)}`;
	const onExclude = vi.fn();
	render(ResendCandidateChips, { candidates: [
		{ ordinal: 1, content, attachmentNames: [] },
		{ ordinal: 2, content: '', attachmentNames: ['synthetic.txt', 'example.png'] },
	], onExclude });
	expect(screen.getByText(content.trim()).textContent).toBe(content.trim());
	await fireEvent.click(screen.getByRole('button', { name: "Don't resend synthetic.txt, example.png" }));
	expect(onExclude).toHaveBeenCalledWith(2);
});
