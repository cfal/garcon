import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { copyToClipboard } = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock('$lib/utils/clipboard.js', () => ({ copyToClipboard }));

import GitCommentAppendError from '../GitCommentAppendError.svelte';

describe('GitCommentAppendError', () => {
	afterEach(cleanup);

	it('copies the formatted comment block when Chat is unavailable', async () => {
		copyToClipboard.mockResolvedValue(true);
		render(GitCommentAppendError, {
			error: 'Open a chat before adding this comment.',
			copyText: 'formatted comment block',
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

		expect(copyToClipboard).toHaveBeenCalledWith(
			'formatted comment block',
			expect.any(HTMLDivElement),
		);
		expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
	});
});
