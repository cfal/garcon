import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import SnippetDraftFormTestHost from './SnippetDraftFormTestHost.svelte';

afterEach(cleanup);

it.each(['resolve', 'reject'] as const)(
	'preserves the replacement form when an old save later %ss',
	async (outcome) => {
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const onSave = vi.fn(
			() =>
				new Promise<void>((yes, no) => {
					resolve = yes;
					reject = no;
				}),
		);
		const onClose = vi.fn();
		const { rerender } = render(SnippetDraftFormTestHost, {
			initialTemplate: 'Original draft',
			onSave,
			onClose,
		});
		await fireEvent.input(await screen.findByRole('textbox', { name: 'Short name' }), {
			target: { value: 'original' },
		});
		await fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
		await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		await rerender({ initialTemplate: 'Replacement draft', onSave, onClose });
		if (outcome === 'resolve') resolve();
		else reject(new Error('old failure'));
		await waitFor(() =>
			expect(
				(screen.getByRole('textbox', { name: 'Snippet text' }) as HTMLTextAreaElement).value,
			).toBe('Replacement draft'),
		);
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.queryByRole('alert')).toBeNull();
	},
);
