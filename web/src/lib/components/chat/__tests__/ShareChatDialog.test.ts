import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShareChatDialog from '../ShareChatDialog.svelte';
import * as sharesApi from '$lib/api/shares';
import * as clipboard from '$lib/utils/clipboard';

vi.mock('$lib/api/shares', () => ({
	shareChat: vi.fn(),
	revokeShare: vi.fn(),
}));

vi.mock('$lib/utils/clipboard', () => ({
	copyToClipboard: vi.fn(),
}));

describe('ShareChatDialog', () => {
	beforeEach(() => {
		vi.mocked(sharesApi.shareChat).mockResolvedValue({
			success: true,
			shareToken: 'share-token',
			shareUrl: '/shared/share-token',
		});
		vi.mocked(clipboard.copyToClipboard).mockResolvedValue(true);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('copies the share URL from inside the dialog focus scope', async () => {
		const expectedUrl = `${window.location.origin}/shared/share-token`;
		render(ShareChatDialog, {
			chatId: 'chat-1',
			chatTitle: 'Share target',
			onClose: vi.fn(),
		});

		await screen.findByText(expectedUrl);
		const copyButton = screen.getByRole('button', { name: 'Copy Link' });
		await fireEvent.click(copyButton);

		await waitFor(() => {
			expect(clipboard.copyToClipboard).toHaveBeenCalledWith(
				expectedUrl,
				document.querySelector('[role="dialog"]'),
			);
		});
		expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();
	});

	it('does not show success when the clipboard helper fails', async () => {
		vi.mocked(clipboard.copyToClipboard).mockResolvedValue(false);
		render(ShareChatDialog, {
			chatId: 'chat-1',
			chatTitle: 'Share target',
			onClose: vi.fn(),
		});

		await screen.findByText(`${window.location.origin}/shared/share-token`);
		await fireEvent.click(screen.getByRole('button', { name: 'Copy Link' }));

		await waitFor(() => {
			expect(clipboard.copyToClipboard).toHaveBeenCalledTimes(1);
		});
		expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
	});
});
