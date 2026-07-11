import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ChatTagEditor from '../ChatTagEditor.svelte';

describe('ChatTagEditor', () => {
	it('adds, suggests, removes, and closes tags through callbacks', async () => {
		const onAdd = vi.fn(() => true);
		const onRemove = vi.fn();
		const onClose = vi.fn();
		render(ChatTagEditor, {
			tags: ['qa'],
			knownTags: ['review-needed'],
			open: true,
			onAdd,
			onRemove,
			onClose,
		});
		const input = screen.getByPlaceholderText('Type a tag...') as HTMLInputElement;

		await fireEvent.input(input, { target: { value: 'rev' } });
		await fireEvent.click(screen.getByRole('button', { name: 'review-needed' }));
		expect(onAdd).toHaveBeenCalledWith('review-needed');
		expect(input.value).toBe('');

		await fireEvent.keyDown(input, { key: 'Backspace' });
		expect(onRemove).toHaveBeenCalledWith('qa');

		await fireEvent.keyDown(input, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledOnce();
	});
});
