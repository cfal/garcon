import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationFeedTestHost from './ConversationFeedTestHost.svelte';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';

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

	it('represents viewport insets as measured virtual items', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'row-ids' });
		const viewport = screen.getByRole('region', { name: 'Chat messages' });

		await waitFor(() =>
			expect(container.querySelector('[data-chat-feed-viewport-start-spacer]')).toBeTruthy(),
		);
		expect(container.querySelector('[data-chat-feed-viewport-end-spacer]')).toBeTruthy();
		expect(viewport.classList.contains('pt-3')).toBe(false);
		expect(viewport.classList.contains('pb-3')).toBe(false);
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

	it('publishes a fresh live-region node for repeated identical announcements', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'row-ids',
			showAnnouncementTrigger: true,
		});
		const status = container.querySelector<HTMLElement>('[role="status"]');
		const button = screen.getByRole('button', { name: 'Announce' });

		await fireEvent.click(button);
		await waitFor(() => expect(status?.textContent).toBe('Repeated update'));
		const firstNode = status?.firstElementChild;
		const firstSequence = status?.dataset.chatFeedAnnouncementSequence;
		await fireEvent.click(button);
		await waitFor(() =>
			expect(status?.dataset.chatFeedAnnouncementSequence).not.toBe(firstSequence),
		);

		expect(status?.textContent).toBe('Repeated update');
		expect(status?.firstElementChild).not.toBe(firstNode);
	});

	it('renders a bounded virtual range instead of every loaded transcript row', () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'local-truncation',
		});
		const mountedItems = container.querySelectorAll('[data-chat-virtual-item]').length;
		const mountedTranscriptRows = container.querySelectorAll('[data-chat-row-id]').length;
		expect(mountedItems).toBeGreaterThan(0);
		expect(mountedTranscriptRows).toBeGreaterThan(0);
		expect(mountedItems).toBeLessThan(120);
		expect(container.querySelector('[data-chat-virtual-sizer]')).toBeTruthy();
	});

	it('keeps a varied twenty-thousand-item transcript below the mounted DOM budget', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'twenty-thousand',
		});
		await waitFor(
			() => {
				const sizer = container.querySelector('[data-chat-virtual-sizer]');
				expect(sizer?.getAttribute('data-chat-virtual-model-count')).toBe('20002');
				const mountedItems = container.querySelectorAll('[data-chat-virtual-item]').length;
				const mountedTranscriptRows = container.querySelectorAll('[data-chat-row-id]').length;
				expect(mountedItems).toBeGreaterThan(0);
				expect(mountedTranscriptRows).toBeGreaterThan(0);
				expect(mountedItems).toBeLessThan(60);
			},
			{ timeout: 10_000 },
		);
	});

	it('ignores a connected stale row measurement after the item count shrinks', async () => {
		const restoreResizeObserver = installResizeObserverHarness();
		let staleRow: HTMLElement | null = null;
		try {
			const { container } = render(ConversationFeedTestHost, {
				transcriptScenario: 'count-shrink',
			});
			await waitFor(() =>
				expect(
					container
						.querySelector('[data-chat-virtual-sizer]')
						?.getAttribute('data-chat-virtual-model-count'),
				).toBe('122'),
			);
			const mountedRows = [
				...container.querySelectorAll<HTMLElement>('[data-chat-virtual-item]'),
			].filter((item) => item.querySelector('[data-chat-row-id]'));
			staleRow = mountedRows.at(-1) ?? null;
			if (!staleRow) throw new Error('Expected a measured virtual row');
			const staleIndex = Number(staleRow.dataset.index);
			expect(staleIndex).toBeGreaterThanOrEqual(22);
			const staleObserver = ResizeObserverHarness.instances.find((observer) =>
				observer.observed.has(staleRow as HTMLElement),
			);
			if (!staleObserver) throw new Error('Expected the stale row to be observed');
			ResizeObserverHarness.emitFrom(staleObserver, staleRow, 900, 240);

			await fireEvent.click(screen.getByRole('button', { name: 'Shrink transcript' }));
			await waitFor(() =>
				expect(
					container
						.querySelector('[data-chat-virtual-sizer]')
						?.getAttribute('data-chat-virtual-model-count'),
				).toBe('22'),
			);
			expect(staleRow.isConnected).toBe(false);
			document.body.append(staleRow);
			expect(staleRow.isConnected).toBe(true);
			ResizeObserverHarness.emitFrom(staleObserver, staleRow, 900, 10_000);

			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			await waitFor(() => {
				const indexes = [
					...container.querySelectorAll<HTMLElement>('[data-chat-virtual-item]'),
				].map((item) => Number(item.dataset.index));
				expect(indexes.length).toBeGreaterThan(0);
				expect(indexes.every((index) => index >= 0 && index < 22)).toBe(true);
				expect(
					Number.parseFloat(
						container.querySelector<HTMLElement>('[data-chat-virtual-sizer]')?.style.height ?? '0',
					),
				).toBeLessThan(10_000);
			});
		} finally {
			staleRow?.remove();
			restoreResizeObserver();
		}
	});

	it('remeasures mounted rows that survive an item count shrink', async () => {
		const restoreResizeObserver = installResizeObserverHarness();
		try {
			const { container } = render(ConversationFeedTestHost, {
				transcriptScenario: 'count-shrink-survivors',
			});
			await waitFor(() =>
				expect(
					container
						.querySelector('[data-chat-virtual-sizer]')
						?.getAttribute('data-chat-virtual-model-count'),
				).toBe('122'),
			);
			const measuredRow = container
				.querySelector('[data-chat-row-id="generation-1:120"]')
				?.closest<HTMLElement>('[data-chat-virtual-item]');
			const followingRow = measuredRow?.nextElementSibling as HTMLElement | null;
			if (!measuredRow || !followingRow) {
				throw new Error('Expected a mounted tail row and end spacer');
			}
			let measurementReads = 0;
			Object.defineProperty(measuredRow, 'offsetHeight', {
				configurable: true,
				get() {
					measurementReads += 1;
					return 600;
				},
			});
			ResizeObserverHarness.emit(measuredRow, 900, 600);

			await fireEvent.click(screen.getByRole('button', { name: 'Shrink transcript keeping tail' }));
			await waitFor(() =>
				expect(
					container
						.querySelector('[data-chat-virtual-sizer]')
						?.getAttribute('data-chat-virtual-model-count'),
				).toBe('22'),
			);
			expect(measuredRow.isConnected).toBe(true);
			expect(followingRow.isConnected).toBe(true);
			for (let frame = 0; frame < 4; frame += 1) {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			}
			expect(measurementReads).toBeGreaterThan(0);
			await waitFor(() => {
				const start = (element: HTMLElement): number =>
					Number(element.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? Number.NaN);
				expect(start(followingRow) - start(measuredRow)).toBe(600);
			});
		} finally {
			restoreResizeObserver();
		}
	});
});
