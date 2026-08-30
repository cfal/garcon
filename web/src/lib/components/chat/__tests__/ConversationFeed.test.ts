import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationFeedTestHost from './ConversationFeedTestHost.svelte';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';

async function showFeedScrollbar(container: HTMLElement): Promise<{
	scrollbar: HTMLElement;
	thumb: HTMLElement;
	viewport: HTMLElement;
}> {
	const root = container.querySelector<HTMLElement>('[data-scroll-area-root]');
	const viewport = container.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
	const content = container.querySelector<HTMLElement>('[data-scroll-area-content]');
	if (!root || !viewport || !content) throw new Error('Expected the feed scroll-area elements');
	Object.defineProperties(viewport, {
		offsetHeight: { configurable: true, value: 720 },
		offsetWidth: { configurable: true, value: 900 },
		scrollHeight: { configurable: true, value: 4_000 },
		scrollWidth: { configurable: true, value: 900 },
	});
	await waitFor(() => {
		expect(
			ResizeObserverHarness.instances.some((observer) => observer.observed.has(viewport)),
		).toBe(true);
		expect(ResizeObserverHarness.instances.some((observer) => observer.observed.has(content))).toBe(
			true,
		);
	});
	for (const observer of ResizeObserverHarness.instances) {
		if (observer.observed.has(viewport)) {
			ResizeObserverHarness.emitFrom(observer, viewport, 900, 720);
		}
		if (observer.observed.has(content)) {
			ResizeObserverHarness.emitFrom(observer, content, 900, 4_000);
		}
	}
	await fireEvent.pointerEnter(root);
	await waitFor(() => expect(container.querySelector('[data-chat-feed-scrollbar]')).not.toBeNull());
	const scrollbar = container.querySelector<HTMLElement>('[data-chat-feed-scrollbar]');
	const thumb = container.querySelector<HTMLElement>('[data-slot="scroll-area-thumb"]');
	if (!scrollbar || !thumb) throw new Error('Expected the feed scrollbar and thumb');
	await tick();
	return { scrollbar, thumb, viewport };
}

describe('ConversationFeed', () => {
	const originalOffsetHeight = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		'offsetHeight',
	);
	const originalClientHeight = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		'clientHeight',
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
		Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
			configurable: true,
			get() {
				if (this.hasAttribute('data-chat-scroll-viewport')) return 720;
				return originalClientHeight?.get?.call(this) ?? 0;
			},
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		if (originalOffsetHeight) {
			Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
		}
		if (originalClientHeight) {
			Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
		}
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

	it('uses fixed transcript typography without CSS zoom', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'row-ids' });

		await waitFor(() => expect(container.querySelector('[data-chat-virtual-sizer]')).toBeTruthy());
		expect(container.querySelector('[data-chat-transcript-scale]')).toBeNull();
		expect(container.querySelector('[style*="zoom"]')).toBeNull();
	});

	it('keeps feed content and scrollbar invisible while preparing the initial position', async () => {
		const { container, rerender } = render(ConversationFeedTestHost, {
			transcriptScenario: 'row-ids',
			isPreparingInitialScroll: true,
		});
		const viewport = container.querySelector('[data-chat-scroll-viewport]') as HTMLElement;
		expect(viewport.getAttribute('aria-busy')).toBe('true');
		const content = container.querySelector('[data-chat-feed-content]') as HTMLElement;
		expect(content.className).toContain('invisible');
		for (const scrollbar of container.querySelectorAll('[data-chat-feed-scrollbar]')) {
			expect(scrollbar.className).toContain('invisible');
		}

		await rerender({ isPreparingInitialScroll: false });
		expect(viewport.getAttribute('aria-busy')).toBe('false');
		expect(content.className).not.toContain('invisible');
		for (const scrollbar of container.querySelectorAll('[data-chat-feed-scrollbar]')) {
			expect(scrollbar.className).not.toContain('invisible');
		}
	});

	it('reports an immediate scrollbar track jump from its committed offset', async () => {
		const restoreResizeObserver = installResizeObserverHarness();
		let feedViewport: HTMLElement | null = null;
		const observedScrollTops: number[] = [];
		const onUserScrollIntent = vi.fn(() => observedScrollTops.push(feedViewport?.scrollTop ?? -1));
		try {
			const { container } = render(ConversationFeedTestHost, {
				onUserScrollIntent,
				transcriptScenario: 'twenty-thousand',
			});
			const { scrollbar, thumb, viewport } = await showFeedScrollbar(container);
			feedViewport = viewport;
			viewport.scrollTop = 500;
			vi.spyOn(thumb, 'getBoundingClientRect').mockReturnValue({ top: 80, bottom: 120 } as DOMRect);
			document.addEventListener('pointerdown', () => (viewport.scrollTop = 0), { once: true });

			await fireEvent.pointerDown(scrollbar, { button: 0, clientY: 90, pointerId: 1 });

			expect(onUserScrollIntent.mock.calls).toEqual([['earlier']]);
			expect(observedScrollTops).toEqual([500]);
			expect(viewport.scrollTop).toBe(0);
		} finally {
			restoreResizeObserver();
		}
	});

	it('reports wheel direction over the custom scrollbar before it scrolls', async () => {
		const restoreResizeObserver = installResizeObserverHarness();
		let feedViewport: HTMLElement | null = null;
		const observedScrollTops: number[] = [];
		const onUserScrollIntent = vi.fn(() => observedScrollTops.push(feedViewport?.scrollTop ?? -1));
		try {
			const { container } = render(ConversationFeedTestHost, {
				onUserScrollIntent,
				transcriptScenario: 'twenty-thousand',
			});
			const { scrollbar, viewport } = await showFeedScrollbar(container);
			feedViewport = viewport;
			viewport.scrollTop = 500;
			document.addEventListener('wheel', () => (viewport.scrollTop = 0), { once: true });

			await fireEvent.wheel(scrollbar, { deltaY: -40 });
			expect(viewport.scrollTop).toBe(0);
			viewport.scrollTop = 500;
			await fireEvent.wheel(scrollbar, { deltaY: 40 });

			expect(onUserScrollIntent.mock.calls).toEqual([['earlier'], ['later']]);
			expect(observedScrollTops).toEqual([500, 500]);
		} finally {
			restoreResizeObserver();
		}
	});

	it('defers thumb pickup until pointer movement establishes direction', async () => {
		const restoreResizeObserver = installResizeObserverHarness();
		const onUserScrollIntent = vi.fn();
		try {
			const { container } = render(ConversationFeedTestHost, {
				onUserScrollIntent,
				transcriptScenario: 'twenty-thousand',
			});
			const { thumb, viewport } = await showFeedScrollbar(container);
			viewport.scrollTop = 500;
			thumb.addEventListener('pointerdown', () => (viewport.scrollTop = 499.5), { once: true });

			await fireEvent.pointerDown(thumb, { button: 0, clientY: 100, pointerId: 2 });
			expect(onUserScrollIntent.mock.calls).toEqual([[null]]);
			await fireEvent.pointerMove(thumb, { buttons: 1, clientY: 80, pointerId: 2 });
			await fireEvent.pointerMove(thumb, { buttons: 1, clientY: 120, pointerId: 2 });
			await fireEvent.pointerUp(thumb, { button: 0, clientY: 120, pointerId: 2 });

			expect(onUserScrollIntent.mock.calls).toEqual([[null], ['earlier'], ['later']]);
		} finally {
			restoreResizeObserver();
		}
	});

	it('keeps the automatic earlier-history boundary out of the transcript', () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'local-truncation',
		});

		expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
		expect(container.querySelector('[data-transcript-page-boundary="earlier"]')).toBeNull();
	});

	it('shows automatic earlier loading outside virtual geometry', () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'loading-earlier',
		});
		const viewport = screen.getByRole('region', { name: 'Chat messages' });
		const indicator = container.querySelector<HTMLElement>('[data-chat-earlier-loading-indicator]');

		expect(indicator?.textContent).toContain('Loading earlier messages...');
		expect(indicator?.classList.contains('top-2')).toBe(true);
		expect(indicator?.classList.contains('left-1/2')).toBe(true);
		expect(indicator?.classList.contains('-translate-x-1/2')).toBe(true);
		expect(indicator?.classList.contains('size-8')).toBe(true);
		expect(indicator?.classList.contains('rounded-full')).toBe(true);
		expect(indicator?.classList.contains('border')).toBe(true);
		expect(indicator?.classList.contains('bg-background')).toBe(true);
		expect(indicator?.classList.contains('shadow-none')).toBe(true);
		expect(indicator?.classList.contains('inset-x-0')).toBe(false);
		expect(screen.getByText('Loading earlier messages...').classList.contains('sr-only')).toBe(
			true,
		);
		expect(indicator?.closest('[data-chat-virtual-sizer]')).toBeNull();
		expect(viewport.contains(indicator)).toBe(false);
		expect(viewport.getAttribute('aria-busy')).toBe('true');
		expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
		expect(container.querySelector('[data-transcript-page-boundary="earlier"]')).toBeNull();
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
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'error-earlier',
		});
		const retry = await screen.findByRole('button', { name: 'Retry earlier messages' });
		const boundary = container.querySelector('[data-transcript-page-boundary="earlier"]');
		const transcript = container.querySelector('[data-chat-row-id]');
		if (!boundary || !transcript) throw new Error('Expected the earlier boundary and transcript');

		expect(boundary.compareDocumentPosition(transcript)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		await fireEvent.click(retry);

		const loading = await screen.findByRole('button', { name: 'Loading earlier messages...' });
		expect(loading.getAttribute('aria-busy')).toBe('true');
		expect(container.querySelector('[data-transcript-page-boundary="earlier"]')).toBe(boundary);
		expect(container.querySelector('[data-chat-earlier-loading-indicator]')).toBeNull();
	});

	it('passes durable and optimistic row identities to mounted virtual rows', async () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'row-ids' });

		await waitFor(() =>
			expect(
				Array.from(
					container.querySelectorAll<HTMLElement>('[data-chat-row-id]'),
					(row) => row.dataset.chatRowId,
				),
			).toEqual(['generation-1:1', 'optimistic:message-1']),
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

	it('bounds a twenty-thousand-entry payload before virtual projection', async () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'twenty-thousand',
		});
		await waitFor(
			() => {
				const sizer = container.querySelector('[data-chat-virtual-sizer]');
				expect(sizer?.getAttribute('data-chat-transcript-entry-count')).toBe('200');
				expect(sizer?.getAttribute('data-chat-virtual-model-count')).toBe('202');
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

	it('preserves measured survivor geometry across count shrink and a later publication', async () => {
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
				throw new Error('Expected the mounted tail row and end spacer');
			}
			const survivorKey = measuredRow.dataset.chatVirtualItem;
			expect(survivorKey).toBeTruthy();
			const viewport = container.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
			if (!viewport) throw new Error('Expected the Chat viewport');
			ResizeObserverHarness.emit(viewport, 900, 720);
			ResizeObserverHarness.emit(measuredRow, 900, 600);
			viewport.scrollTop += 37;
			await fireEvent.scroll(viewport);

			await fireEvent.click(screen.getByRole('button', { name: 'Shrink transcript keeping tail' }));
			await tick();
			await fireEvent.click(screen.getByRole('button', { name: 'Show earlier error' }));
			await tick();
			await waitFor(() =>
				expect(
					container
						.querySelector('[data-chat-virtual-sizer]')
						?.getAttribute('data-chat-virtual-model-count'),
				).toBe('23'),
			);
			expect(measuredRow.isConnected).toBe(true);
			expect(followingRow.isConnected).toBe(true);
			expect(measuredRow.dataset.chatVirtualItem).toBe(survivorKey);
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
