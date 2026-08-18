import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedChatPageTestHost from './SharedChatPageTestHost.svelte';
import * as sharesApi from '$lib/api/shares';
import type { GetSharedChatResponse } from '$shared/share-types';

vi.mock('$lib/api/shares', () => ({
	getSharedChat: vi.fn(),
}));

function response(
	contents: string[],
	start: number,
	totalMessages = 250,
	pageOverrides: Partial<GetSharedChatResponse['page']> = {},
): GetSharedChatResponse {
	return {
		snapshot: {
			shareToken: 'share-token',
			chatId: 'chat-1',
			title: 'Large shared chat',
			agentId: 'codex',
			model: 'gpt-5',
			projectPath: '/workspace/garcon',
			sharedAt: pageOverrides.snapshotVersion ?? '2025-01-02T03:04:05.000Z',
			messages: contents.map((content, index) => ({
				type: 'assistant-message',
				timestamp: `2025-01-02T03:05:${String(index).padStart(2, '0')}.000Z`,
				content,
			})),
		},
		page: {
			snapshotVersion: '2025-01-02T03:04:05.000Z',
			totalMessages,
			start,
			end: start + contents.length,
			nextBefore: start > 0 ? start : null,
			...pageOverrides,
		},
	};
}

describe('SharedChatPage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('scrollTo', vi.fn());
		vi.stubGlobal(
			'matchMedia',
			vi.fn(() => ({
				matches: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('renders a bounded newest page and prepends older messages on demand', async () => {
		vi.mocked(sharesApi.getSharedChat)
			.mockResolvedValueOnce(response(['newest-1', 'newest-2'], 50))
			.mockResolvedValueOnce(response(['oldest-1', 'oldest-2'], 0));

		render(SharedChatPageTestHost);

		await screen.findByText('newest-1');
		const newestMessage = screen.getByText('newest-1').closest('.chat-message');
		expect(screen.getByText('2 of 250 messages')).toBeTruthy();
		expect(sharesApi.getSharedChat).toHaveBeenNthCalledWith(1, 'share-token');

		await fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));

		await screen.findByText('oldest-1');
		await waitFor(() => {
			expect(sharesApi.getSharedChat).toHaveBeenNthCalledWith(
				2,
				'share-token',
				50,
				'2025-01-02T03:04:05.000Z',
			);
		});
		expect(screen.getByText('4 of 250 messages')).toBeTruthy();
		expect(screen.getByText('newest-1').closest('.chat-message')).toBe(newestMessage);
		expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
	});

	it('anchors from the viewport position when an older-page request completes', async () => {
		let resolveOlder!: (value: GetSharedChatResponse) => void;
		vi.mocked(sharesApi.getSharedChat)
			.mockResolvedValueOnce(response(['newest'], 50))
			.mockImplementationOnce(
				() => new Promise<GetSharedChatResponse>((resolve) => (resolveOlder = resolve)),
			);
		const scrollTo = vi.mocked(window.scrollTo);
		let scrollY = 40;
		vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
		vi.spyOn(document.documentElement, 'scrollHeight', 'get')
			.mockReturnValueOnce(1_000)
			.mockReturnValueOnce(1_250);

		render(SharedChatPageTestHost);
		await screen.findByText('newest');
		await fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
		await waitFor(() => expect(sharesApi.getSharedChat).toHaveBeenCalledTimes(2));

		scrollY = 275;
		resolveOlder(response(['older'], 0));
		await screen.findByText('older');
		await waitFor(() =>
			expect(scrollTo).toHaveBeenLastCalledWith({ top: 525, behavior: 'instant' }),
		);
	});

	it('restarts from the newest page when a share updates between page requests', async () => {
		vi.mocked(sharesApi.getSharedChat)
			.mockResolvedValueOnce(response(['old-newest'], 50))
			.mockResolvedValueOnce(
				response(['updated-newest'], 70, 270, {
					snapshotVersion: '2025-01-02T04:04:05.000Z',
					reset: true,
				}),
			);

		render(SharedChatPageTestHost);
		await screen.findByText('old-newest');

		await fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));

		await screen.findByText('updated-newest');
		expect(screen.queryByText('old-newest')).toBeNull();
		expect(screen.getByText('1 of 270 messages')).toBeTruthy();
		await waitFor(() => {
			expect(sharesApi.getSharedChat).toHaveBeenNthCalledWith(
				2,
				'share-token',
				50,
				'2025-01-02T03:04:05.000Z',
			);
		});
	});

	it('renders shared notice and error chat rows with distinct cards', async () => {
		const chatRows = response([], 0, 2, { nextBefore: null });
		chatRows.snapshot.messages = [
			{
				type: 'transcript-notice',
				timestamp: '2025-01-02T03:05:00.000Z',
				content: 'Shared notice.\nSecond line.',
			},
			{
				type: 'error',
				timestamp: '2025-01-02T03:05:01.000Z',
				content: 'Shared error.',
			},
		];
		chatRows.page.end = 2;
		vi.mocked(sharesApi.getSharedChat).mockResolvedValueOnce(chatRows);

		const { container } = render(SharedChatPageTestHost);

		const error = await screen.findByText('Shared error.');
		const noticeCard = container.querySelector('article.border-status-info-border');
		expect(noticeCard?.querySelector('.whitespace-pre-wrap')?.textContent).toBe(
			'Shared notice.\nSecond line.',
		);
		expect(error.closest('article')?.className).toContain('border-status-error-border');
		expect(screen.getByText('2 of 2 messages')).toBeTruthy();
	});
});
