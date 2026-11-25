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
			onClose: vi.fn(),
		});

		await screen.findByText(expectedUrl);
		const copyButton = screen.getByRole('button', { name: 'Copy Link' });
		await fireEvent.click(copyButton);

		await waitFor(() => {
			expect(clipboard.copyToClipboard).toHaveBeenCalledWith(
				expectedUrl,
				document.querySelector('[role="dialog"]'),
				expect.any(Function),
			);
		});
		expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();
	});

	it('ignores an earlier share completion after switching chats', async () => {
		const first = Promise.withResolvers<Awaited<ReturnType<typeof sharesApi.shareChat>>>();
		vi.mocked(sharesApi.shareChat).mockReturnValueOnce(first.promise);
		const { rerender } = render(ShareChatDialog, { chatId: 'first', onClose: vi.fn() });
		expect(sharesApi.shareChat).toHaveBeenCalledWith('first');
		await rerender({ chatId: 'second' });
		const currentUrl = `${window.location.origin}/shared/share-token`;
		await screen.findByText(currentUrl);
		first.resolve({ success: true, shareToken: 'old', shareUrl: '/shared/old' });
		await first.promise;
		await waitFor(() => expect(screen.getByText(currentUrl)).toBeTruthy());
		expect(screen.queryByText(`${window.location.origin}/shared/old`)).toBeNull();
	});

	it('ignores a rejected request from before closing and reopening the same chat', async () => {
		const first = Promise.withResolvers<Awaited<ReturnType<typeof sharesApi.shareChat>>>();
		vi.mocked(sharesApi.shareChat).mockReturnValueOnce(first.promise);
		const { rerender } = render(ShareChatDialog, { chatId: 'chat-1', onClose: vi.fn() });
		await rerender({ chatId: null });
		await rerender({ chatId: 'chat-1' });
		const currentUrl = `${window.location.origin}/shared/share-token`;
		await screen.findByText(currentUrl);
		first.reject(new Error('Old request failed'));
		await first.promise.catch(() => undefined);
		await waitFor(() => expect(screen.getByText(currentUrl)).toBeTruthy());
		expect(screen.queryByText('Failed to create share link')).toBeNull();
	});

	it('does not show success when the clipboard helper fails', async () => {
		vi.mocked(clipboard.copyToClipboard).mockResolvedValue(false);
		render(ShareChatDialog, {
			chatId: 'chat-1',
			onClose: vi.fn(),
		});

		await screen.findByText(`${window.location.origin}/shared/share-token`);
		await fireEvent.click(screen.getByRole('button', { name: 'Copy Link' }));

		await waitFor(() => {
			expect(clipboard.copyToClipboard).toHaveBeenCalledTimes(1);
		});
		expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
	});

	it('clears copied-state cleanup when unmounted', async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
		const view = render(ShareChatDialog, {
			chatId: 'chat-1',
			onClose: vi.fn(),
		});

		await screen.findByText(`${window.location.origin}/shared/share-token`);
		await fireEvent.click(screen.getByRole('button', { name: 'Copy Link' }));
		await screen.findByRole('button', { name: 'Copied!' });
		const resetTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 2000);
		expect(resetTimerIndex).toBeGreaterThanOrEqual(0);
		const resetTimer = setTimeoutSpy.mock.results[resetTimerIndex]?.value;

		view.unmount();

		expect(clearTimeoutSpy).toHaveBeenCalledWith(resetTimer);
		setTimeoutSpy.mockRestore();
		clearTimeoutSpy.mockRestore();
	});
});
