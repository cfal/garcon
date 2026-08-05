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
	shouldPreserveConversationVirtualEdge,
} from '../conversation-feed-viewport-geometry';
import ConversationFeedVirtualControllerTestHost from './ConversationFeedVirtualControllerTestHost.svelte';

describe('ConversationFeedVirtualController helpers', () => {
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
		const first = createRetainedConversationRangeExtractor([], 7);
		const second = createRetainedConversationRangeExtractor([0], 7);
		const range = { startIndex: 2, endIndex: 3, overscan: 0, count: 10 };

		expect(second).not.toBe(first);
		expect(first(range)).toEqual([2, 3, 7, 8, 9]);
		expect(second(range)).toEqual([0, 2, 3, 7, 8, 9]);
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

describe('ConversationFeedVirtualController', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		virtualizerSubscriptions.teardowns.length = 0;
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
	});

	it('keeps content and retention publications separate from structural measurement', async () => {
		const { exposure } = await renderController();
		const measure = vi.spyOn(exposure.instance, 'measure');
		const setOptions = vi.spyOn(exposure.instance, 'setOptions');

		await fireEvent.click(screen.getByRole('button', { name: 'Publish content' }));
		await nextFrame();
		expect(setOptions).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Retain first' }));
		await waitFor(() => expect(setOptions).toHaveBeenCalled());
		expect(Object.keys(setOptions.mock.lastCall?.[0] ?? {})).toEqual(['rangeExtractor']);

		// The adapter reattaches its own setOptions binding on every store emission, so the spy
		// above detached when the retention publication emitted. Assert the same-surface count
		// shrink through the options TanStack actually applied: new options, no measurement pass.
		await fireEvent.click(screen.getByRole('button', { name: 'Shrink' }));
		await waitFor(() => {
			expect(
				document.querySelector('[data-controller-sizer]')?.getAttribute(
					'data-controller-model-count',
				),
			).toBe('4');
		});
		await nextFrame();
		await nextFrame();
		expect(exposure.instance.options.count).toBe(4);
		expect(measure).not.toHaveBeenCalled();
	});

	it('resets text-scale measurements immediately when visible and once on show when hidden', async () => {
		const { exposure } = await renderController();
		const measure = vi.spyOn(exposure.instance, 'measure');

		await fireEvent.click(screen.getByRole('button', { name: 'Toggle scale' }));
		await waitFor(() => expect(measure).toHaveBeenCalledOnce());

		measure.mockClear();
		await fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
		await waitFor(() =>
			expect(document.querySelector('[data-controller-viewport]')?.getAttribute('data-visible')).toBe(
				'false',
			),
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle scale' }));
		await nextFrame();
		await nextFrame();
		expect(measure).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Show and restore' }));
		await waitFor(() => expect(measure).toHaveBeenCalledOnce());
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
		expect(ResizeObserverHarness.instances.some((observer) => observer.observed.size > 0)).toBe(true);

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
		exposure.controller.cancelForUserIntent();
		await nextFrame();
		await nextFrame();
		await nextFrame();
		expect(scrollToOffset).not.toHaveBeenCalled();
		expect(scrollToIndex).not.toHaveBeenCalled();

		// The uncancelled control restore proves the deferred write lands without the gesture.
		exposure.controller.restoreInitialEnd();
		await waitFor(() => expect(scrollToOffset).toHaveBeenCalled());
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
