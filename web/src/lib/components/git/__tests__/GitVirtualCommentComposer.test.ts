import { render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitVirtualCommentComposer from '../GitVirtualCommentComposer.svelte';

describe('GitVirtualCommentComposer', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('focuses only for an explicit pending focus request', async () => {
		const scrollIntoView = vi.fn();
		HTMLElement.prototype.scrollIntoView = scrollIntoView;
		const onFocusHandled = vi.fn();
		const props = {
			body: '',
			severity: 'note' as const,
			focusPending: false,
			onFocusHandled,
		};
		const { container, rerender, unmount } = render(GitVirtualCommentComposer, { props });

		expect(scrollIntoView).not.toHaveBeenCalled();
		expect(container.querySelector('textarea')).not.toBe(document.activeElement);

		await rerender({ ...props, focusPending: true });
		await waitFor(() => expect(onFocusHandled).toHaveBeenCalledOnce());
		expect(scrollIntoView).toHaveBeenCalledOnce();
		expect(container.querySelector('textarea')).toBe(document.activeElement);

		unmount();
		render(GitVirtualCommentComposer, { props });
		expect(scrollIntoView).toHaveBeenCalledOnce();
	});
});
