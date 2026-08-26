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

	it('renders CLI provenance while retaining generic notice and error paths', async () => {
		const chatRows = response([], 0, 6, { nextBefore: null });
		chatRows.snapshot.messages = [
			{
				type: 'cli-row',
				timestamp: '2025-01-02T03:04:59.000Z',
				content: 'Shared information.',
				title: 'Consultation status',
				presentation: { style: 'info' },
				format: 'plain',
				disclosure: 'collapsed',
			},
			{
				type: 'transcript-notice',
				timestamp: '2025-01-02T03:05:00.000Z',
				content: 'Shared notice.\nSecond line.',
				title: 'Deployment',
				detail: { type: 'cli-row' },
			},
			{
				type: 'error',
				timestamp: '2025-01-02T03:05:01.000Z',
				content: 'Shared error.',
				title: 'Release validation',
				detail: { type: 'cli-row' },
			},
			{
				type: 'transcript-notice',
				timestamp: '2025-01-02T03:05:02.000Z',
				content: 'Internal notice.',
			},
			{
				type: 'error',
				timestamp: '2025-01-02T03:05:03.000Z',
				content: 'Provider error.',
			},
			{
				type: 'cli-row',
				timestamp: '2025-01-02T03:05:04.000Z',
				content: '**Shared custom deployment.**',
				title: 'Custom deployment',
				presentation: {
					style: 'custom',
					customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
				},
				format: 'markdown',
			},
		];
		chatRows.page.end = 6;
		vi.mocked(sharesApi.getSharedChat).mockResolvedValueOnce(chatRows);

		const { container } = render(SharedChatPageTestHost);

		const infoCard = (await screen.findByText('Consultation status')).closest('article');
		const noticeCard = screen.getByText('Deployment').closest('article');
		const errorCard = screen.getByText('Release validation').closest('article');
		const customCard = (await screen.findByText('Shared custom deployment.')).closest('article');
		expect(infoCard?.className).toContain('cli-row-message-info');
		expect(infoCard?.className).toContain('border-status-neutral-border');
		const disclosure = screen.getByRole('button', { name: 'Show more' });
		expect(disclosure.getAttribute('aria-expanded')).toBe('false');
		await fireEvent.click(disclosure);
		expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
		expect(screen.getByText('CLI info').className).toContain('sr-only');
		expect(noticeCard?.className).toContain('cli-row-message');
		expect(noticeCard?.className).toContain('border-status-info-border');
		expect(screen.getByText('CLI notice').className).toContain('sr-only');
		expect(noticeCard?.querySelector('.whitespace-pre-wrap')?.textContent).toBe(
			'Shared notice.\nSecond line.',
		);
		expect(errorCard?.className).toContain('cli-row-message');
		expect(errorCard?.className).toContain('border-status-error-border');
		expect(screen.getByText('CLI error').className).toContain('sr-only');
		expect(screen.getByText('Internal notice.').closest('article')?.className)
			.toContain('border-status-info-border');
		expect(screen.getByText('Provider error.').closest('article')?.className)
			.toContain('border-status-error-border');
		expect(customCard?.className).toContain('cli-row-message-custom');
		expect(customCard?.className).toContain('cli-presentation-custom');
		expect(customCard?.querySelector('strong')?.textContent).toBe('Shared custom deployment.');
		expect(customCard?.parentElement?.style.getPropertyValue('--cli-presentation-accent-light'))
			.toBe('#7c3aed');
		expect(customCard?.parentElement?.style.getPropertyValue('--cli-presentation-accent-dark'))
			.toBe('#c4b5fd');
		expect(container.querySelectorAll('article.cli-row-message')).toHaveLength(4);
		expect(screen.getByText('6 of 6 messages')).toBeTruthy();
	});

	it('renders shared handoff summaries as Markdown', async () => {
		const shared = response([], 0, 1, { nextBefore: null });
		shared.snapshot.messages = [{
			type: 'transcript-notice',
			timestamp: '2025-01-02T03:05:00.000Z',
			content: '## Current objective\n\nPreserve **typed provenance**.',
			title: 'Handoff summary',
			detail: { type: 'handoff-summary' },
		}];
		shared.page.end = 1;
		vi.mocked(sharesApi.getSharedChat).mockResolvedValueOnce(shared);

		const { container } = render(SharedChatPageTestHost);

		await screen.findByText('Handoff summary');
		expect(container.querySelector('h2')?.textContent).toBe('Current objective');
		expect(container.querySelector('strong')?.textContent).toBe('typed provenance');
	});

	it('styles the complete shared CLI user message surface', async () => {
		const shared = response([], 0, 1, { nextBefore: null });
		shared.snapshot.messages = [{
			type: 'user-message',
			timestamp: '2025-01-02T03:04:59.000Z',
			content: '**Shared deployment.**',
			presentation: {
				origin: 'cli',
				style: 'custom',
				customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
				title: 'Deployment context',
			},
		}];
		shared.page.end = 1;
		vi.mocked(sharesApi.getSharedChat).mockResolvedValueOnce(shared);

		const { container } = render(SharedChatPageTestHost);
		await screen.findByText('Shared deployment.');

		const bubble = container.querySelector<HTMLElement>(
			'[data-user-message-presentation="custom"]',
		);
		expect(bubble?.classList.contains('cli-presentation-custom')).toBe(true);
		expect(bubble?.style.getPropertyValue('--cli-presentation-accent-light')).toBe('#7c3aed');
		expect(bubble?.style.getPropertyValue('--cli-presentation-accent-dark')).toBe('#c4b5fd');
		expect(screen.getByText('CLI custom').className).toContain('sr-only');
		expect(screen.getByText('Deployment context')).toBeTruthy();
	});

	it('renders attachments with duplicate filenames', async () => {
		const chatRows = response([], 0, 1, { nextBefore: null });
		chatRows.snapshot.messages = [
			{
				type: 'user-message',
				timestamp: '2025-01-02T03:05:00.000Z',
				content: 'Two screenshots',
				images: [
					{ name: 'image.png', data: 'data:image/png;base64,one' },
					{ name: 'image.png', data: 'data:image/png;base64,two' },
				],
			},
		];
		chatRows.page.end = 1;
		vi.mocked(sharesApi.getSharedChat).mockResolvedValueOnce(chatRows);

		const { container } = render(SharedChatPageTestHost);

		await screen.findByText('Two screenshots');
		expect(container.querySelectorAll('img')).toHaveLength(2);
		expect(screen.queryByText(/Failed to render message/)).toBeNull();
	});
});
