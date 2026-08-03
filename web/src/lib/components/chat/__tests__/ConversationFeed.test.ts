import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationFeedTestHost from './ConversationFeedTestHost.svelte';

describe('ConversationFeed', () => {
	const originalOffsetHeight = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		'offsetHeight',
	);

	beforeEach(() => {
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLElement,
		) {
			const itemIndex = Number(this.dataset.index ?? 0);
			const itemHeights = [48, 96, 180, 240];
			const height = this.hasAttribute('data-scroll-area-viewport')
				? 720
				: this.hasAttribute('data-chat-virtual-item')
					? itemHeights[itemIndex % itemHeights.length]
					: 100;
			return {
				x: 0,
				y: 0,
				top: 0,
				left: 0,
				right: 900,
				bottom: height,
				width: 900,
				height,
				toJSON: () => ({}),
			} as DOMRect;
		});
		Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
			configurable: true,
			get() {
				if (!this.hasAttribute('data-chat-virtual-item')) return 0;
				const itemHeights = [48, 96, 180, 240];
				return itemHeights[Number(this.dataset.index ?? 0) % itemHeights.length];
			},
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		if (originalOffsetHeight) {
			Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
		}
	});

	it('omits the top floating toolbar spacer by default', () => {
		const { container } = render(ConversationFeedTestHost);

		expect(container.querySelector('[data-chat-feed-top-floating-toolbar-spacer]')).toBeNull();
	});

	it('renders the floating toolbar reservation inside scrollable feed content', async () => {
		const { container } = render(ConversationFeedTestHost, {
			reserveTopFloatingToolbar: true,
			transcriptScenario: 'row-ids',
		});

		const viewport = screen.getByRole('region', { name: 'Chat messages' });
		await waitFor(() =>
			expect(container.querySelector('[data-chat-feed-top-floating-toolbar-spacer]')).toBeTruthy(),
		);
		const spacer = container.querySelector<HTMLElement>(
			'[data-chat-feed-top-floating-toolbar-spacer]',
		);
		const transcript = container.querySelector<HTMLElement>('[data-chat-row-id]');

		expect(spacer).toBeTruthy();
		expect(transcript).toBeTruthy();
		expect(viewport.contains(spacer)).toBe(true);
		expect(viewport.contains(transcript)).toBe(true);
		expect(spacer?.classList.contains('h-[var(--workspace-floating-taskbar-inset)]')).toBe(true);
		expect(spacer?.compareDocumentPosition(transcript as Node)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(container.querySelector('[data-chat-bottom-anchor]')).toBeNull();
	});

	it('reserves toolbar space above empty feed states', () => {
		const { container } = render(ConversationFeedTestHost, { reserveTopFloatingToolbar: true });
		const viewport = screen.getByRole('region', { name: 'Chat messages' });
		const spacer = container.querySelector('[data-chat-top-toolbar-spacer]');

		expect(spacer).toBeTruthy();
		expect(viewport.contains(spacer)).toBe(true);
	});

	it('hides the local truncation control during the automatic initial reveal', () => {
		render(ConversationFeedTestHost, { transcriptScenario: 'initial-reveal' });

		expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
	});

	it('shows a directional earlier boundary after the automatic reveal window', async () => {
		render(ConversationFeedTestHost, { transcriptScenario: 'local-truncation' });

		expect(await screen.findByRole('button', { name: 'Load earlier messages' })).toBeTruthy();
		expect(screen.queryByText('Load more')).toBeNull();
	});

	it('renders later loading below the transcript without a native bottom anchor', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'loading-later',
		});
		const transcript = container.querySelector('[data-chat-row-id]');
		const boundary = container.querySelector('[data-transcript-page-boundary="later"]');

		expect(await screen.findByText('Loading later messages...')).toBeTruthy();
		expect(screen.getByRole('region', { name: 'Chat messages' }).getAttribute('aria-busy')).toBe(
			'true',
		);
		expect(transcript?.compareDocumentPosition(boundary as Node)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(container.querySelector('[data-chat-bottom-anchor]')).toBeNull();
	});

	it('keeps an earlier failure in flow as a directional retry', async () => {
		render(ConversationFeedTestHost, { transcriptScenario: 'error-earlier' });

		expect(await screen.findByRole('button', { name: 'Retry earlier messages' })).toBeTruthy();
	});

	it('passes durable and pending row identities to mounted virtual rows', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'row-ids' });

		await waitFor(() =>
			expect(
				Array.from(
					container.querySelectorAll<HTMLElement>('[data-chat-row-id]'),
					(row) => row.dataset.chatRowId,
				),
			).toEqual(['generation-1:1', 'pending:request-1']),
		);
	});

	it('uses a non-live browsing region and a stable dedicated announcer', () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'row-ids' });
		const viewport = screen.getByRole('region', { name: 'Chat messages' });
		const announcer = container.querySelector('[role="status"]');

		expect(viewport.getAttribute('aria-live')).toBe('off');
		expect(announcer?.getAttribute('aria-live')).toBe('polite');
		expect(announcer?.closest('[data-chat-virtual-sizer]')).toBeNull();
	});

	it('renders a bounded virtual range instead of every loaded transcript row', () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'local-truncation',
		});
		expect(container.querySelectorAll('[data-chat-virtual-item]').length).toBeLessThan(120);
		expect(container.querySelector('[data-chat-virtual-sizer]')).toBeTruthy();
	});

	it('keeps a varied twenty-thousand-item transcript below the mounted DOM budget', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'twenty-thousand',
		});
		await waitFor(
			() => {
				const sizer = container.querySelector('[data-chat-virtual-sizer]');
				expect(sizer?.getAttribute('data-chat-virtual-model-count')).toBe('20000');
				expect(container.querySelectorAll('[data-chat-virtual-item]').length).toBeLessThan(60);
			},
			{ timeout: 10_000 },
		);
	});
});
