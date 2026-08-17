import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { SvelteVirtualizer } from '@tanstack/svelte-virtual';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness';
import { ConversationFeedVirtualController } from '../ConversationFeedVirtualController.svelte.js';

const virtualizerSubscriptions = vi.hoisted(() => ({
	teardowns: [] as Array<Mock<() => void>>,
}));

// Records each store subscription teardown so tests can observe the controller unsubscribing
// exactly once; all virtualizer behavior stays real.
vi.mock('@tanstack/svelte-virtual', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@tanstack/svelte-virtual')>();
	const createVirtualizer: typeof actual.createVirtualizer = (options) => {
		const store = actual.createVirtualizer(options);
		return {
			subscribe(run, invalidate) {
				const teardown = vi.fn(store.subscribe(run, invalidate));
				virtualizerSubscriptions.teardowns.push(teardown);
				return teardown;
			},
		};
	};
	return { ...actual, createVirtualizer };
});
import {
	classifyMeasuredConversationViewportFill,
	classifyConversationVirtualStructure,
	attainableConversationTargetOffset,
	createRetainedConversationRangeExtractor,
	isConversationTargetLayoutReady,
	retainedConversationRange,
	resolveConversationViewportRect,
	selectConversationReadingAnchor,
	selectConversationReadingRestoreAnchor,
	shouldPreserveConversationVirtualEdge,
} from '../conversation-feed-viewport-geometry';
import {
	conversationAnchorScrollOffset,
	conversationAnchorViewportOffset,
	ConversationEarlierPrependAnchorOwnership,
	ConversationPreCommitAnchorBuffer,
	ConversationProgrammaticScrollOwnership,
	ConversationMountedVirtualItems,
	type ConversationVirtualAnchorSettlePort,
	positionCommittedConversationAnchor,
	positionPendingConversationAnchor,
	settleConversationVirtualAnchor,
} from '../conversation-feed-virtual-runtime';
import ConversationFeedVirtualControllerTestHost from './ConversationFeedVirtualControllerTestHost.svelte';

function createAnchorSettleFixture(options: {
	readScrollOffset(): number | null;
	isCurrent(): boolean;
	onScrollToOffset?(offset: number): void;
}) {
	const mountedItems = new ConversationMountedVirtualItems();
	const element = document.createElement('div');
	element.dataset.index = '0';
	element.dataset.chatVirtualItem = 'anchor';
	document.body.append(element);
	mountedItems.add(element);
	const cancelScroll = vi.fn();
	const scrollToOffset = vi.fn(options.onScrollToOffset);
	const instance = {
		options: { scrollMargin: 0 },
		cancelScroll,
		getVirtualItems: () => [{ index: 0, key: 'anchor', start: 100, size: 50, end: 150, lane: 0 }],
		scrollToIndex: vi.fn(),
		scrollToOffset,
	} satisfies ConversationVirtualAnchorSettlePort;

	return {
		cancelScroll,
		destroy: () => element.remove(),
		scrollToOffset,
		settle: () =>
			settleConversationVirtualAnchor({
				instance,
				mountedItems,
				configuredKeys: ['anchor'],
				key: 'anchor',
				index: 0,
				viewportOffset: 0,
				readScrollOffset: options.readScrollOffset,
				isCurrent: options.isCurrent,
			}),
	};
}

describe('ConversationFeedVirtualController helpers', () => {
	it('invalidates superseded programmatic scroll ownership epochs', () => {
		const ownership = new ConversationProgrammaticScrollOwnership();
		const first = ownership.begin();
		expect(ownership.ownsPosition).toBe(true);

		ownership.cancel();
		expect(ownership.isCurrent(first)).toBe(false);
		expect(ownership.ownsPosition).toBe(false);

		const second = ownership.begin();
		ownership.finish(first);
		expect(ownership.ownsPosition).toBe(true);
		ownership.finish(second);
		expect(ownership.ownsPosition).toBe(false);
	});

	it('consumes only the matching pre-commit anchor policy', () => {
		const buffer = new ConversationPreCommitAnchorBuffer();
		const nearest = { key: 'nearest', viewportOffset: 4, fallbackKeys: [] };
		const transcript = { key: 'transcript', viewportOffset: 8, fallbackKeys: [] };
		buffer.capture(2, (preferTranscript) => (preferTranscript ? transcript : nearest));

		expect(buffer.take(2, true)).toBe(transcript);
		expect(buffer.take(2, false)).toBeNull();
		buffer.capture(3, (preferTranscript) => (preferTranscript ? transcript : nearest));
		expect(buffer.take(4, false)).toBeNull();
	});

	it('preserves anchor coordinates when the virtual scroll margin changes', () => {
		const viewportOffset = conversationAnchorViewportOffset(2_404, 0, 1_975);

		expect(viewportOffset).toBe(429);
		expect(conversationAnchorScrollOffset(1_808, 59.8, viewportOffset)).toBeCloseTo(1_319.2);
	});

	it('skips a settled anchor write while retaining the post-frame cancellation check', async () => {
		let animationFrame = 0;
		let current = true;
		const requestAnimationFrame = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback) => {
				animationFrame += 1;
				if (animationFrame === 2) current = false;
				callback(performance.now());
				return animationFrame;
			});
		const fixture = createAnchorSettleFixture({
			readScrollOffset: () => 100.25,
			isCurrent: () => current,
		});

		try {
			await expect(fixture.settle()).resolves.toBe(false);
			expect(fixture.scrollToOffset).not.toHaveBeenCalled();
			expect(fixture.cancelScroll).not.toHaveBeenCalled();
			expect(animationFrame).toBe(2);
		} finally {
			requestAnimationFrame.mockRestore();
			fixture.destroy();
		}
	});

	it('writes an anchor outside tolerance and validates the settled geometry', async () => {
		const requestAnimationFrame = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback) => {
				callback(performance.now());
				return 1;
			});
		let scrollOffset = 99;
		const fixture = createAnchorSettleFixture({
			readScrollOffset: () => scrollOffset,
			isCurrent: () => true,
			onScrollToOffset: (offset) => {
				scrollOffset = offset;
			},
		});

		try {
			await expect(fixture.settle()).resolves.toBe(true);
			expect(fixture.scrollToOffset).toHaveBeenCalledOnce();
			expect(fixture.scrollToOffset).toHaveBeenCalledWith(100, { behavior: 'auto' });
			expect(fixture.cancelScroll).toHaveBeenCalledOnce();
		} finally {
			requestAnimationFrame.mockRestore();
			fixture.destroy();
		}
	});

	it('cancels reconciliation after a current anchor settles without an offset write', async () => {
		const requestAnimationFrame = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback) => {
				callback(performance.now());
				return 1;
			});
		const fixture = createAnchorSettleFixture({
			readScrollOffset: () => 100.25,
			isCurrent: () => true,
		});

		try {
			await expect(fixture.settle()).resolves.toBe(true);
			expect(fixture.scrollToOffset).not.toHaveBeenCalled();
			expect(fixture.cancelScroll).toHaveBeenCalledOnce();
		} finally {
			requestAnimationFrame.mockRestore();
			fixture.destroy();
		}
	});

	it('does not cancel reconciliation while anchor geometry remains unsettled', async () => {
		const requestAnimationFrame = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback) => {
				callback(performance.now());
				return 1;
			});
		const fixture = createAnchorSettleFixture({
			readScrollOffset: () => 99,
			isCurrent: () => true,
		});

		try {
			await expect(fixture.settle()).resolves.toBe(false);
			expect(fixture.scrollToOffset).toHaveBeenCalled();
			expect(fixture.cancelScroll).not.toHaveBeenCalled();
		} finally {
			requestAnimationFrame.mockRestore();
			fixture.destroy();
		}
	});

	it('does not carry directionless press origins into later gestures', () => {
		const ownership = new ConversationEarlierPrependAnchorOwnership();
		const anchor = { key: 'anchor', viewportOffset: 0, fallbackKeys: [] };
		ownership.carry(anchor, true);

		expect(ownership.preserves(null, anchor, 80)).toBe(true);
		expect(ownership.preserves('earlier', anchor, 0)).toBe(true);
		ownership.clear();
		ownership.carry(anchor, true);
		expect(ownership.preserves(null, anchor, 0)).toBe(true);
		expect(ownership.preserves('earlier', anchor, 80)).toBe(false);
	});

	it('retains mounted rows only through the owning prepend restore', () => {
		const ownership = new ConversationEarlierPrependAnchorOwnership();
		const anchor = { key: 'anchor', viewportOffset: 0, fallbackKeys: [] };
		ownership.beginMountedRowRetention(['mounted']);
		ownership.retainMountedRow('attached');
		expect(ownership.retainedMountedRowKeys).toEqual(new Set(['mounted', 'attached']));
		expect(
			ownership.retainedIndexes(
				[1],
				new Map([
					['mounted', 4],
					['attached', 5],
				]),
			),
		).toEqual([1, 4, 5]);

		ownership.carry(anchor, true);
		ownership.complete(anchor);
		expect(ownership.retainedMountedRowKeys).toBeNull();
	});

	it('keeps a prepend clamped when its publication begins before the anchor is carried', () => {
		const ownership = new ConversationEarlierPrependAnchorOwnership();
		const anchor = { key: 'anchor', viewportOffset: 0, fallbackKeys: [] };
		ownership.beginMountedRowRetention([], true);

		expect(ownership.preserves('earlier', null, 0)).toBe(true);
		ownership.carry(anchor, true);

		expect(ownership.preserves('earlier', anchor, 80)).toBe(true);
	});

	it('blocks stale thumb motion until a clamped prepend drag moves later or ends', () => {
		const ownership = new ConversationEarlierPrependAnchorOwnership();
		const anchor = { key: 'anchor', viewportOffset: 12, fallbackKeys: [] };
		ownership.beginMountedRowRetention([], true, true);
		ownership.carry(anchor, true);

		expect(ownership.preserves('earlier', anchor, 7_900, 'scrollbar-drag')).toBe(true);
		expect(ownership.blocksViewportMutation('scrollbar-drag')).toBe(true);
		expect(ownership.blocksViewportMutation('viewport')).toBe(false);
		ownership.complete(anchor);
		expect(ownership.blocksViewportMutation('scrollbar-drag')).toBe(true);

		expect(ownership.preserves('later', null, 7_900, 'scrollbar-drag')).toBe(false);
		expect(ownership.blocksViewportMutation('scrollbar-drag')).toBe(false);
		ownership.beginMountedRowRetention([], true, true);
		ownership.finishScrollbarDrag();
		expect(ownership.blocksViewportMutation('scrollbar-drag')).toBe(false);
	});

	it('positions a committed anchor before its next animation frame', () => {
		const viewport = document.createElement('div');
		const element = document.createElement('div');
		viewport.scrollTop = 120;
		vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 40 } as DOMRect);
		vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ top: 390 } as DOMRect);
		const scrollToOffset = vi.fn();

		positionCommittedConversationAnchor({
			element,
			viewport,
			viewportOffset: 50,
			scrollToOffset,
		});

		expect(scrollToOffset).toHaveBeenCalledWith(420);
	});

	it('positions only the connected wrapper for the pending keyed index', () => {
		const viewport = document.createElement('div');
		const element = document.createElement('div');
		viewport.append(element);
		document.body.append(viewport);
		element.dataset.chatVirtualItem = 'anchor';
		element.dataset.index = '4';
		viewport.scrollTop = 120;
		vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 40 } as DOMRect);
		vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ top: 390 } as DOMRect);
		const scrollToOffset = vi.fn();
		const input = {
			anchor: { key: 'anchor', viewportOffset: 50, fallbackKeys: [] },
			element,
			virtualItem: { key: 'anchor', index: 4 },
			indexByKey: new Map([['anchor', 4]]),
			viewport,
			scrollToOffset,
		};

		positionPendingConversationAnchor(input);
		expect(scrollToOffset).toHaveBeenCalledWith(420);

		scrollToOffset.mockClear();
		element.dataset.index = '3';
		positionPendingConversationAnchor(input);
		expect(scrollToOffset).not.toHaveBeenCalled();
		viewport.remove();
	});

	it('classifies identity, edge, estimate-only, and no-op changes', () => {
		expect(
			classifyConversationVirtualStructure({
				identityChanged: true,
				previousKeys: ['a'],
				previousEstimates: [10],
				nextKeys: ['a'],
				nextEstimates: [10],
			}),
		).toBe('identity');
		expect(
			classifyConversationVirtualStructure({
				identityChanged: false,
				previousKeys: ['b'],
				previousEstimates: [10],
				nextKeys: ['a', 'b'],
				nextEstimates: [10, 10],
			}),
		).toBe('edge-qualified');
		expect(
			classifyConversationVirtualStructure({
				identityChanged: false,
				previousKeys: ['a', 'b', 'c'],
				previousEstimates: [10, 10, 10],
				nextKeys: ['a', 'x', 'c'],
				nextEstimates: [10, 10, 10],
			}),
		).toBe('interior-only');
		expect(
			classifyConversationVirtualStructure({
				identityChanged: false,
				previousKeys: ['a'],
				previousEstimates: [10],
				nextKeys: ['a'],
				nextEstimates: [10],
			}),
		).toBe('none');
	});

	it('adds sorted, valid retained indexes to a possibly disjoint range', () => {
		expect(
			retainedConversationRange(
				{ startIndex: 4, endIndex: 6, overscan: 0, count: 10 },
				[9, 1, 5, -1, 12],
			),
		).toEqual([1, 4, 5, 6, 9]);
	});

	it('retains the pinned transcript tail and its trailing surface', () => {
		expect(
			retainedConversationRange({ startIndex: 1, endIndex: 2, overscan: 0, count: 10 }, [], 7),
		).toEqual([1, 2, 7, 8, 9]);
	});

	it('publishes a fresh range extractor when retention policy changes', () => {
		const first = createRetainedConversationRangeExtractor([], 7, 0);
		const second = createRetainedConversationRangeExtractor([0], 7, 0);
		const range = { startIndex: 2, endIndex: 3, overscan: 0, count: 10 };

		expect(second).not.toBe(first);
		expect(first(range)).toEqual([2, 3, 7, 8, 9]);
		expect(second(range)).toEqual([0, 2, 3, 7, 8, 9]);
	});

	it('keeps a following row buffer mounted below the active range', () => {
		const extract = createRetainedConversationRangeExtractor([]);
		const indexes = extract({ startIndex: 10, endIndex: 12, overscan: 2, count: 50 });

		expect(indexes).toContain(24);
		expect(indexes).not.toContain(25);
	});

	it('preserves detached edge changes without overriding pinned or navigation policy', () => {
		expect(
			shouldPreserveConversationVirtualEdge({
				structure: 'edge-qualified',
				endBehavior: 'restore-if-pinned',
				restorePolicyEnd: false,
			}),
		).toBe(true);
		expect(
			shouldPreserveConversationVirtualEdge({
				structure: 'edge-qualified',
				endBehavior: 'restore-if-pinned',
				restorePolicyEnd: true,
			}),
		).toBe(false);
		expect(
			shouldPreserveConversationVirtualEdge({
				structure: 'edge-qualified',
				endBehavior: 'explicit-navigation',
				restorePolicyEnd: false,
			}),
		).toBe(false);
	});

	it('restores only geometry that can move the reading anchor start', () => {
		const anchor = { key: 'anchor' };
		expect(
			selectConversationReadingRestoreAnchor({
				candidateAnchor: anchor,
				pendingAnchor: null,
				previous: {
					keys: ['start', 'before', 'anchor', 'end'],
					estimates: [16, 80, 120, 16],
				},
				next: {
					keys: ['start', 'before', 'anchor', 'appended', 'end'],
					estimates: [16, 80, 120, 180, 16],
				},
			}),
		).toBeNull();
		expect(
			selectConversationReadingRestoreAnchor({
				candidateAnchor: anchor,
				pendingAnchor: null,
				previous: {
					keys: ['start', 'before', 'anchor', 'end'],
					estimates: [16, 80, 120, 16],
				},
				next: {
					keys: ['start', 'prepended', 'before', 'anchor', 'end'],
					estimates: [16, 180, 80, 120, 16],
				},
			}),
		).toBe(anchor);
		expect(
			selectConversationReadingRestoreAnchor({
				candidateAnchor: anchor,
				pendingAnchor: null,
				previous: { keys: ['start', 'before', 'anchor'], estimates: [16, 80, 120] },
				next: { keys: ['start', 'before', 'anchor'], estimates: [16, 96, 120] },
			}),
		).toBe(anchor);
		expect(
			selectConversationReadingRestoreAnchor({
				candidateAnchor: anchor,
				pendingAnchor: anchor,
				previous: { keys: ['start', 'before', 'anchor'], estimates: [16, 80, 120] },
				next: { keys: ['start', 'before', 'anchor'], estimates: [16, 80, 120] },
			}),
		).toBe(anchor);
	});

	it('anchors the first meaningfully visible transcript item instead of a subpixel sliver', () => {
		const items = [
			{ key: 'prefix', end: 20 },
			{ key: 'prior', end: 100 },
			{ key: 'visible', end: 180 },
		];
		const transcriptKeys = new Set(['prior', 'visible']);

		expect(selectConversationReadingAnchor(items, 99.5, transcriptKeys)?.key).toBe('visible');
		expect(selectConversationReadingAnchor(items, 98, transcriptKeys)?.key).toBe('prior');
	});

	it('reports overflow from any contiguous measured run without combining gaps', () => {
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b', 'c'],
				measuredSizes: new Map([
					['b', 300],
					['c', 120],
				]),
				renderedKeys: new Set<string>(),
				estimates: [],
				leadingSize: 16,
				viewportHeight: 400,
			}),
		).toBe('overflow');
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b', 'c'],
				measuredSizes: new Map([
					['a', 250],
					['c', 200],
				]),
				renderedKeys: new Set<string>(),
				estimates: [],
				leadingSize: 16,
				viewportHeight: 400,
			}),
		).toBeNull();
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b'],
				measuredSizes: new Map([
					['a', 100],
					['b', 120],
				]),
				renderedKeys: new Set<string>(),
				estimates: [],
				leadingSize: 16,
				viewportHeight: 400,
			}),
		).toBe('underfilled');
	});

	it('resolves rendered keys without cache entries to their exact estimates', () => {
		// TanStack omits the cache entry when a wrapper renders at its estimate, so a
		// rendered key must classify as measured instead of forcing another probe.
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b', 'c'],
				measuredSizes: new Map([['a', 250]]),
				renderedKeys: new Set(['b', 'c']),
				estimates: [120, 90, 60],
				leadingSize: 16,
				viewportHeight: 400,
			}),
		).toBe('overflow');
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b'],
				measuredSizes: new Map([['a', 100]]),
				renderedKeys: new Set(['b']),
				estimates: [120, 90],
				leadingSize: 16,
				viewportHeight: 400,
			}),
		).toBe('underfilled');
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b'],
				measuredSizes: new Map([['a', 100]]),
				renderedKeys: new Set(['a']),
				estimates: [120, 90],
				leadingSize: 16,
				viewportHeight: 400,
			}),
		).toBeNull();
	});

	it('clamps target alignment to attainable scroll boundaries', () => {
		expect(
			attainableConversationTargetOffset({
				currentOffset: 0,
				alignmentDelta: -120,
				maximumOffset: 900,
			}),
		).toBe(0);
		expect(
			attainableConversationTargetOffset({
				currentOffset: 850,
				alignmentDelta: 100,
				maximumOffset: 900,
			}),
		).toBe(900);
		expect(
			attainableConversationTargetOffset({
				currentOffset: 300,
				alignmentDelta: 75,
				maximumOffset: 900,
			}),
		).toBe(375);
	});

	it('retains the last usable viewport rect across pathological observations', () => {
		const previous = { width: 1_024, height: 720 };
		expect(resolveConversationViewportRect(previous, { width: 5, height: 5 })).toEqual({
			width: 5,
			height: 5,
		});
		expect(resolveConversationViewportRect(previous, { width: 0, height: 600 })).toBe(previous);
		expect(resolveConversationViewportRect(previous, { width: 390, height: 24 })).toEqual({
			width: 390,
			height: 24,
		});
	});

	it('waits for pending rich content and image dimensions before settling a target', () => {
		const row = document.createElement('div');
		const pending = document.createElement('div');
		pending.dataset.chatLayoutPending = 'true';
		row.append(pending);
		expect(isConversationTargetLayoutReady(row)).toBe(false);

		pending.dataset.chatLayoutPending = 'false';
		const image = document.createElement('img');
		Object.defineProperty(image, 'complete', { configurable: true, value: false });
		row.append(image);
		expect(isConversationTargetLayoutReady(row)).toBe(false);

		Object.defineProperty(image, 'complete', { configurable: true, value: true });
		expect(isConversationTargetLayoutReady(row)).toBe(true);
	});
});

interface ControllerExposure {
	controller: ConversationFeedVirtualController;
	instance: SvelteVirtualizer<HTMLElement, HTMLDivElement>;
	initialEndRestoredCount(): number;
	prepareHiddenOffsetWithMissingAnchor(): Promise<void>;
	prepareHiddenOffsetWithoutAnchor(): Promise<void>;
	prependWithRetainedWithheldAnchor(index: number): Promise<void>;
	releaseWithheldEndItem(): Promise<void>;
	restoreHiddenWithConcurrentGeometry(): Promise<void>;
	stageEarlierPrependWithTail(index: number): Promise<void>;
	stageLatchedEarlierPrependWithTail(index: number): Promise<void>;
	withholdEndItem(): Promise<void>;
	withholdItem(index: number): Promise<void>;
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function renderController(): Promise<{
	exposure: ControllerExposure;
	unmount(): void;
}> {
	let exposure: ControllerExposure | undefined;
	const rendered = render(ConversationFeedVirtualControllerTestHost, {
		onReady(value) {
			exposure = value;
		},
	});
	await waitFor(() => expect(exposure).toBeDefined());
	await nextFrame();
	await nextFrame();
	if (!exposure) throw new Error('Expected the virtual controller exposure');
	return { exposure, unmount: rendered.unmount };
}

async function preparePendingEarlierPrepend(
	publish: (exposure: ControllerExposure, index: number) => Promise<void>,
) {
	const { exposure } = await renderController();
	const viewport = document.querySelector<HTMLDivElement>('[data-controller-viewport]');
	if (!viewport) throw new Error('Expected the controller viewport');
	await fireEvent.click(screen.getByRole('button', { name: 'Toggle pinned' }));
	viewport.scrollTop = 86;
	viewport.dispatchEvent(new Event('scroll'));
	await nextFrame();
	const readingItem = exposure.instance.getVirtualItemForOffset(viewport.scrollTop);
	if (!readingItem) throw new Error('Expected a virtual reading item');
	const readingOffset = conversationAnchorViewportOffset(
		readingItem.start,
		exposure.instance.options.scrollMargin,
		viewport.scrollTop,
	);
	const scrollToIndex = vi.spyOn(exposure.instance, 'scrollToIndex');
	const scrollToOffset = vi.spyOn(exposure.instance, 'scrollToOffset');

	await publish(exposure, readingItem.index);
	expect(
		Array.from(document.querySelectorAll<HTMLElement>('[data-chat-virtual-item]')).some(
			(element) => element.dataset.chatVirtualItem === String(readingItem.key),
		),
	).toBe(false);
	const repositionedItem = exposure.instance
		.getVirtualItems()
		.find((item) => item.key === readingItem.key);
	if (!repositionedItem) throw new Error('Expected the reading item after the prepend');
	const expectedScrollOffset = conversationAnchorScrollOffset(
		repositionedItem.start,
		exposure.instance.options.scrollMargin,
		readingOffset,
	);
	return { exposure, viewport, scrollToIndex, scrollToOffset, expectedScrollOffset };
}

describe('ConversationFeedVirtualController', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		virtualizerSubscriptions.teardowns.length = 0;
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
		vi.restoreAllMocks();
	});

	it('keeps content and retention publications separate from structural measurement', async () => {
		const { exposure } = await renderController();
		const measure = vi.spyOn(exposure.instance, 'measure');
		const setOptions = vi.spyOn(exposure.instance, 'setOptions');
		const rangeExtractor = exposure.instance.options.rangeExtractor;

		await fireEvent.click(screen.getByRole('button', { name: 'Publish content' }));
		await nextFrame();
		expect(setOptions).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Retain first' }));
		await waitFor(() => expect(setOptions).toHaveBeenCalledOnce());
		expect(Object.keys(setOptions.mock.lastCall?.[0] ?? {})).toEqual(['rangeExtractor']);
		expect(exposure.instance.options.rangeExtractor).not.toBe(rangeExtractor);
		expect(
			exposure.instance.options.rangeExtractor({
				startIndex: 2,
				endIndex: 3,
				overscan: 0,
				count: 12,
			}),
		).toContain(0);

		// A same-surface count shrink still updates TanStack without a measurement pass.
		await fireEvent.click(screen.getByRole('button', { name: 'Shrink' }));
		await waitFor(() => {
			expect(
				document
					.querySelector('[data-controller-sizer]')
					?.getAttribute('data-controller-model-count'),
			).toBe('4');
		});
		await nextFrame();
		await nextFrame();
		expect(exposure.instance.options.count).toBe(4);
		expect(measure).not.toHaveBeenCalled();
	});

	it('leaves detached tail append anchoring to TanStack without a keyed restore', async () => {
		const { exposure } = await renderController();
		const viewport = document.querySelector<HTMLDivElement>('[data-controller-viewport]');
		if (!viewport) throw new Error('Expected the controller viewport');
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle pinned' }));
		viewport.scrollTop = 80;
		viewport.dispatchEvent(new Event('scroll'));
		await nextFrame();
		const scrollToIndex = vi.spyOn(exposure.instance, 'scrollToIndex');

		await fireEvent.click(screen.getByRole('button', { name: 'Append' }));
		await waitFor(() =>
			expect(
				document
					.querySelector('[data-controller-sizer]')
					?.getAttribute('data-controller-model-count'),
			).toBe('13'),
		);
		await nextFrame();
		await nextFrame();

		expect(scrollToIndex).not.toHaveBeenCalled();
	});

	it('releases viewport ownership after a simple programmatic scroll settles', async () => {
		const { exposure } = await renderController();

		exposure.controller.scrollBy(10);
		expect(exposure.controller.ownsScrollPosition()).toBe(true);

		await waitFor(() => expect(exposure.controller.ownsScrollPosition()).toBe(false));
	});

	it.each([
		['a hidden offset without a reading anchor', 'prepareHiddenOffsetWithoutAnchor'],
		['a hidden offset whose reading anchor disappeared', 'prepareHiddenOffsetWithMissingAnchor'],
	] as const)('owns %s until its fallback restore settles', async (_label, prepare) => {
		const { exposure } = await renderController();
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle pinned' }));
		await exposure[prepare]();
		const scrollToOffset = exposure.instance.scrollToOffset.bind(exposure.instance);
		const ownedDuringWrite: boolean[] = [];
		vi.spyOn(exposure.instance, 'scrollToOffset').mockImplementation((offset, options) => {
			ownedDuringWrite.push(exposure.controller.ownsScrollPosition());
			scrollToOffset(offset, options);
		});

		await expect(exposure.controller.restoreHiddenReadingPosition()).resolves.toBe('restored');
		expect(ownedDuringWrite).toEqual([true]);
		expect(exposure.controller.ownsScrollPosition()).toBe(false);
	});

	it('keeps a mounted edge anchor settled without first aligning it to the top', async () => {
		const { exposure } = await renderController();
		const viewport = document.querySelector<HTMLDivElement>('[data-controller-viewport]');
		if (!viewport) throw new Error('Expected the controller viewport');
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle pinned' }));
		viewport.scrollTop = 86;
		viewport.dispatchEvent(new Event('scroll'));
		await nextFrame();
		const readingItem = exposure.instance.getVirtualItemForOffset(viewport.scrollTop);
		if (!readingItem) throw new Error('Expected a virtual reading item');
		const readingOffset = conversationAnchorViewportOffset(
			readingItem.start,
			exposure.instance.options.scrollMargin,
			viewport.scrollTop,
		);
		expect(readingOffset).toBeLessThan(0);
		const scrollToIndex = vi.spyOn(exposure.instance, 'scrollToIndex');
		const scrollToOffset = vi.spyOn(exposure.instance, 'scrollToOffset');

		await fireEvent.click(screen.getByRole('button', { name: 'Prepend' }));
		await waitFor(() =>
			expect(
				exposure.instance.getVirtualItems().find((item) => item.key === readingItem.key)?.index,
			).toBe(readingItem.index + 4),
		);
		const repositionedItem = exposure.instance.getVirtualItems().find((item) => item.key === readingItem.key);
		if (!repositionedItem) throw new Error('Expected the reading item after the prepend');
		const expectedScrollOffset = conversationAnchorScrollOffset(
			repositionedItem.start,
			exposure.instance.options.scrollMargin,
			readingOffset,
		);
		expect(viewport.scrollTop).toBeCloseTo(expectedScrollOffset);
		expect(scrollToIndex).not.toHaveBeenCalled();
		expect(scrollToOffset).not.toHaveBeenCalled();
	});

	it('keeps a clamped prepend latched through a tail publication', async () => {
		const { exposure, viewport, scrollToIndex, scrollToOffset, expectedScrollOffset } =
			await preparePendingEarlierPrepend((current, index) =>
				current.stageLatchedEarlierPrependWithTail(index),
			);
		scrollToIndex.mockClear();
		scrollToOffset.mockClear();
		viewport.scrollTop = 80;
		exposure.controller.cancelForUserIntent('earlier');
		await exposure.releaseWithheldEndItem();

		await waitFor(() =>
			expect(scrollToOffset).toHaveBeenCalledWith(expectedScrollOffset, { behavior: 'auto' }),
		);
	});

	it('keeps an unlatched earlier prepend through a tail publication at the clamped edge', async () => {
		const { exposure, viewport, scrollToIndex, scrollToOffset, expectedScrollOffset } =
			await preparePendingEarlierPrepend((current, index) =>
				current.stageEarlierPrependWithTail(index),
			);
		scrollToIndex.mockClear();
		scrollToOffset.mockClear();
		viewport.scrollTop = 0;
		exposure.controller.cancelForUserIntent('earlier');
		await exposure.releaseWithheldEndItem();

		await waitFor(() =>
			expect(scrollToOffset).toHaveBeenCalledWith(expectedScrollOffset, { behavior: 'auto' }),
		);
	});

	it('cancels a pending earlier prepend after a tail publication away from the edge', async () => {
		const { exposure, viewport, scrollToIndex, scrollToOffset } =
			await preparePendingEarlierPrepend((current, index) =>
				current.stageEarlierPrependWithTail(index),
			);
		scrollToIndex.mockClear();
		scrollToOffset.mockClear();
		viewport.scrollTop = 80;
		exposure.controller.cancelForUserIntent(null);
		exposure.controller.cancelForUserIntent('earlier');
		scrollToIndex.mockClear();
		scrollToOffset.mockClear();
		await exposure.releaseWithheldEndItem();
		for (let frame = 0; frame < 10; frame += 1) await nextFrame();

		expect(scrollToIndex).not.toHaveBeenCalled();
		expect(scrollToOffset).not.toHaveBeenCalled();
	});

	it('uses an index target when a retained virtual anchor has no committed wrapper', async () => {
		const { exposure } = await renderController();
		const viewport = document.querySelector<HTMLDivElement>('[data-controller-viewport]');
		if (!viewport) throw new Error('Expected the controller viewport');
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle pinned' }));
		viewport.scrollTop = 86;
		viewport.dispatchEvent(new Event('scroll'));
		await nextFrame();
		const readingItem = exposure.instance.getVirtualItemForOffset(viewport.scrollTop);
		if (!readingItem) throw new Error('Expected a virtual reading item');
		const scrollToIndex = vi.spyOn(exposure.instance, 'scrollToIndex');

		await exposure.prependWithRetainedWithheldAnchor(readingItem.index);
		await waitFor(() =>
			expect(scrollToIndex).toHaveBeenCalledWith(readingItem.index + 4, {
				align: 'start',
				behavior: 'auto',
			}),
		);
	});

	it('resets text-scale measurements immediately when visible and once on show when hidden', async () => {
		const { exposure } = await renderController();
		const measure = vi.spyOn(exposure.instance, 'measure');

		await fireEvent.click(screen.getByRole('button', { name: 'Toggle scale' }));
		await waitFor(() => expect(measure).toHaveBeenCalledOnce());

		measure.mockClear();
		await fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
		await waitFor(() =>
			expect(
				document.querySelector('[data-controller-viewport]')?.getAttribute('data-visible'),
			).toBe('false'),
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle scale' }));
		await nextFrame();
		await nextFrame();
		expect(measure).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Show and restore' }));
		await waitFor(() => expect(measure).toHaveBeenCalledOnce());
	});

	it('keeps the hidden reading anchor through concurrent show-time geometry', async () => {
		const { exposure } = await renderController();
		const viewport = document.querySelector<HTMLDivElement>('[data-controller-viewport]');
		if (!viewport) throw new Error('Expected the controller viewport');
		viewport.scrollTop = 180;
		viewport.dispatchEvent(new Event('scroll'));
		await nextFrame();
		const readingItem = exposure.instance.getVirtualItemForOffset(viewport.scrollTop);
		if (!readingItem) throw new Error('Expected a virtual reading item');

		await fireEvent.click(screen.getByRole('button', { name: 'Toggle pinned' }));
		const scrollToIndex = vi.spyOn(exposure.instance, 'scrollToIndex');

		await exposure.restoreHiddenWithConcurrentGeometry();
		await nextFrame();
		await nextFrame();
		expect(scrollToIndex).toHaveBeenCalled();
		expect(scrollToIndex.mock.lastCall).toEqual([
			readingItem.index,
			{ align: 'start', behavior: 'auto' },
		]);
	});

	it('captures a scale anchor from the virtual rows Svelte has committed', async () => {
		const { exposure } = await renderController();
		const viewport = document.querySelector<HTMLDivElement>('[data-controller-viewport]');
		if (!viewport) throw new Error('Expected the controller viewport');
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle pinned' }));
		await nextFrame();
		const virtualItems = exposure.instance.getVirtualItems();
		const uncommittedItem =
			exposure.instance.getVirtualItemForOffset(viewport.scrollTop) ?? virtualItems.at(-1);
		const committedItem = virtualItems.findLast((item) => item.index !== uncommittedItem?.index);
		if (!uncommittedItem || !committedItem) {
			throw new Error('Expected distinct virtual reading items');
		}
		await exposure.withholdItem(uncommittedItem.index);

		const scrollToIndex = vi.spyOn(exposure.instance, 'scrollToIndex');
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle scale' }));

		await waitFor(() =>
			expect(scrollToIndex).toHaveBeenCalledWith(committedItem.index, {
				align: 'start',
				behavior: 'auto',
			}),
		);
	});

	it('clears prior measurements when the surface identity changes', async () => {
		const { exposure } = await renderController();
		const measure = vi.spyOn(exposure.instance, 'measure');

		await fireEvent.click(screen.getByRole('button', { name: 'Replace surface' }));
		await waitFor(() => expect(measure).toHaveBeenCalledOnce());
		expect(exposure.instance.options.getItemKey(0)).toBe('["surface-2",0]');
	});

	it('cleans adapter observers across repeated destroy calls', async () => {
		const { exposure, unmount } = await renderController();
		expect(ResizeObserverHarness.instances.some((observer) => observer.observed.size > 0)).toBe(
			true,
		);

		expect(() => {
			exposure.controller.destroy();
			exposure.controller.destroy();
		}).not.toThrow();
		expect(unmount).not.toThrow();
		await waitFor(() =>
			expect(
				ResizeObserverHarness.instances.every((observer) => observer.observed.size === 0),
			).toBe(true),
		);
	});

	it('drops deferred end restores when user intent lands mid-flight', async () => {
		const { exposure } = await renderController();
		const scrollToOffset = vi.spyOn(exposure.instance, 'scrollToOffset');
		const scrollToIndex = vi.spyOn(exposure.instance, 'scrollToIndex');

		exposure.controller.restoreInitialEnd();
		exposure.controller.cancelForUserIntent(null);
		await nextFrame();
		await nextFrame();
		await nextFrame();
		expect(scrollToOffset).not.toHaveBeenCalled();
		expect(scrollToIndex).not.toHaveBeenCalled();

		// The uncancelled control restore proves the deferred write lands without the gesture.
		exposure.controller.restoreInitialEnd();
		await waitFor(() => expect(scrollToOffset).toHaveBeenCalled());
	});

	it('cancels TanStack reconciliation only when user intent supersedes owned scrolling', async () => {
		const { exposure } = await renderController();
		const cancelScroll = vi.spyOn(exposure.instance, 'cancelScroll');

		exposure.controller.cancelForUserIntent(null);
		expect(cancelScroll).not.toHaveBeenCalled();

		exposure.controller.scrollToEnd();
		expect(exposure.controller.ownsScrollPosition()).toBe(true);
		exposure.controller.cancelForUserIntent(null);

		expect(cancelScroll).toHaveBeenCalledOnce();
	});

	it('releases the initial paint gate after bounded streaming geometry', async () => {
		const { exposure } = await renderController();
		const viewport = document.querySelector<HTMLDivElement>('[data-controller-viewport]');
		if (!viewport) throw new Error('Expected the controller viewport');
		let physicalHeight = 400;
		Object.defineProperties(viewport, {
			clientHeight: { configurable: true, value: 200 },
			scrollHeight: {
				configurable: true,
				get: () => (physicalHeight += 10),
			},
		});

		exposure.controller.scrollToEnd();

		await waitFor(() => expect(exposure.initialEndRestoredCount()).toBe(1));
	});

	it('keeps the initial paint gate closed until the current virtual range commits', async () => {
		const { exposure } = await renderController();
		await exposure.withholdEndItem();

		exposure.controller.scrollToEnd();
		for (let frame = 0; frame < 10; frame += 1) await nextFrame();
		expect(exposure.initialEndRestoredCount()).toBe(0);

		await exposure.releaseWithheldEndItem();
		await waitFor(() => expect(exposure.initialEndRestoredCount()).toBe(1));
	});

	it('keeps the initial paint gate closed through TanStack scroll settlement', async () => {
		const { exposure } = await renderController();
		exposure.instance.isScrolling = true;

		exposure.controller.scrollToEnd();
		for (let frame = 0; frame < 10; frame += 1) await nextFrame();
		expect(exposure.initialEndRestoredCount()).toBe(0);

		exposure.instance.isScrolling = false;
		await waitFor(() => expect(exposure.initialEndRestoredCount()).toBe(1));
	});

	it('restores the detached reading anchor on text-scale resets instead of the end', async () => {
		const { exposure } = await renderController();
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle pinned' }));
		const measure = vi.spyOn(exposure.instance, 'measure');
		const scrollToIndex = vi.spyOn(exposure.instance, 'scrollToIndex');
		const scrollToOffset = vi.spyOn(exposure.instance, 'scrollToOffset');

		await fireEvent.click(screen.getByRole('button', { name: 'Toggle scale' }));
		await waitFor(() => expect(measure).toHaveBeenCalledOnce());
		// The end restore path never targets an index; the anchor restore always starts with one.
		await waitFor(() =>
			expect(scrollToIndex).toHaveBeenCalledWith(expect.any(Number), {
				align: 'start',
				behavior: 'auto',
			}),
		);
		await waitFor(() => expect(scrollToOffset).toHaveBeenCalled());
		expect(measure).toHaveBeenCalledOnce();
	});

	it('tears down the virtualizer store subscription exactly once across repeated destroys', async () => {
		const { exposure } = await renderController();
		// The controller subscription is the first one issued against its own store.
		const controllerTeardown = virtualizerSubscriptions.teardowns[0];
		expect(controllerTeardown).toBeDefined();
		expect(controllerTeardown).not.toHaveBeenCalled();

		exposure.controller.destroy();
		exposure.controller.destroy();
		expect(controllerTeardown).toHaveBeenCalledTimes(1);
	});

	it('drives measurement only through TanStack ingress, never the measureElement option', async () => {
		const { exposure } = await renderController();
		const instance = exposure.instance;
		// The adapter merges the current options into every publication, so a spy installed on the
		// resolved options survives all controller setOptions calls.
		const measureElement = vi.fn(instance.options.measureElement);
		instance.options.measureElement = measureElement;

		await fireEvent.click(screen.getByRole('button', { name: 'Shrink' }));
		await nextFrame();
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle scale' }));
		await nextFrame();
		await fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
		await waitFor(() =>
			expect(
				document.querySelector('[data-controller-viewport]')?.getAttribute('data-visible'),
			).toBe('false'),
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Show and restore' }));
		await nextFrame();
		await nextFrame();
		// Surface replacement recreates every row element, forcing fresh attachment ingress.
		await fireEvent.click(screen.getByRole('button', { name: 'Replace surface' }));
		await waitFor(() => expect(measureElement).toHaveBeenCalled());
		await nextFrame();
		await nextFrame();

		// TanStack ingress always passes the virtualizer as the third argument; a direct Garcon
		// call to the configured option would record a different shape.
		for (const call of measureElement.mock.calls) {
			expect(call).toHaveLength(3);
			expect(call[2]).toBe(instance);
		}
	});
});
