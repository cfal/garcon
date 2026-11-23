import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import GitCommentModal from '../GitCommentModal.svelte';
import type { CommentComposerState } from '$lib/git/review/git-inline-comment.svelte.js';

afterEach(cleanup);

async function openComment(focusPending: boolean) {
	const composer: CommentComposerState = {
		open: true,
		focusPending,
		filePath: 'example.ts',
		side: 'after',
		line: 1,
		body: 'Draft comment',
		severity: 'note',
	};
	const props = {
		composer,
		onBodyChange: vi.fn(),
		onSeverityChange: vi.fn(),
		onFocusHandled: vi.fn(),
		onSubmit: vi.fn(),
		onClose: vi.fn(),
	};
	render(GitCommentModal, props);
	return { dialog: await screen.findByRole('dialog', { name: 'Add to chat' }), props };
}

it.each([true, false])(
	'focuses the mobile draft on open (focusPending=%s)',
	async (focusPending) => {
		const { dialog, props } = await openComment(focusPending);
		expect(document.activeElement).toBe(within(dialog).getByRole('textbox'));
		expect(props.onFocusHandled).toHaveBeenCalledTimes(focusPending ? 1 : 0);
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
		expect(props.onClose).toHaveBeenCalledOnce();
		expect(props.onSubmit).not.toHaveBeenCalled();
		expect(props.onBodyChange).not.toHaveBeenCalled();
	},
);

it('leaves composing Escape to the IME and dismisses on ordinary Escape', async () => {
	const { dialog, props } = await openComment(true);
	const textarea = within(dialog).getByRole('textbox');
	for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
		const event = new KeyboardEvent('keydown', {
			key: 'Escape',
			bubbles: true,
			cancelable: true,
			...composition,
		});
		await fireEvent(textarea, event);
		expect(props.onClose).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	}
	await fireEvent.keyDown(textarea, { key: 'Escape' });
	expect(props.onClose).toHaveBeenCalledOnce();
});
