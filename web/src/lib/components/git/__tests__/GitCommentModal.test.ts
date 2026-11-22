import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import GitCommentModal from '../GitCommentModal.svelte';
import type { CommentComposerState } from '$lib/git/review/git-inline-comment.svelte.js';

afterEach(cleanup);

it('focuses the mobile comment draft and closes without submitting it', async () => {
	const composer: CommentComposerState = {
		open: true,
		focusPending: true,
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
	const dialog = await screen.findByRole('dialog', { name: 'Add to chat' });
	expect(document.activeElement).toBe(within(dialog).getByRole('textbox'));
	expect(props.onFocusHandled).toHaveBeenCalledOnce();
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
	expect(props.onClose).toHaveBeenCalledOnce();
	expect(props.onSubmit).not.toHaveBeenCalled();
	expect(props.onBodyChange).not.toHaveBeenCalled();
});
