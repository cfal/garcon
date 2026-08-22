import {
	_resetIOSDetectionForTests,
	Virtualizer,
	type VirtualizerOptions,
} from '@tanstack/virtual-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface VirtualizerHarness {
	virtualizer: Virtualizer<HTMLDivElement, HTMLElement>;
	scrollElement: HTMLDivElement;
	contentElement: HTMLDivElement;
	scrollToFn: ReturnType<typeof vi.fn>;
	onChange: ReturnType<typeof vi.fn>;
	destroy(): void;
	dispatchTouch(type: 'touchstart' | 'touchend' | 'touchcancel', identifiers?: number[]): void;
	emitResize(node: HTMLElement, height: number): void;
	emitScrollOffset(offset: number, isScrolling?: boolean): void;
	runAnimationFrames(): void;
	setKeys(keys: readonly string[]): void;
}

function virtualElement(index: number, height = 50): HTMLElement {
	const element = document.createElement('div');
	element.dataset.index = String(index);
	vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, height));
	document.body.append(element);
	return element;
}

function createVirtualizerHarness(initialKeys: readonly string[]): VirtualizerHarness {
	let keys = initialKeys;
	let resizeCallback: ResizeObserverCallback | null = null;
	let offsetCallback: ((offset: number, isScrolling: boolean) => void) | null = null;
	let nextAnimationFrameId = 1;
	const animationFrames = new Map<number, FrameRequestCallback>();
	vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
		const id = nextAnimationFrameId++;
		animationFrames.set(id, callback);
		return id;
	});
	vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
		animationFrames.delete(id);
	});
	const resizeObserver = {
		observe: () => {},
		unobserve: () => {},
		disconnect: () => {},
	} satisfies ResizeObserver;
	class HarnessResizeObserver implements ResizeObserver {
		constructor(callback: ResizeObserverCallback) {
			resizeCallback = callback;
		}

		observe(_target: Element, _options?: ResizeObserverOptions): void {}
		unobserve(_target: Element): void {}
		disconnect(): void {}
	}
	vi.stubGlobal('ResizeObserver', HarnessResizeObserver);

	const scrollElement = document.createElement('div');
	Object.defineProperties(scrollElement, {
		scrollWidth: { configurable: true, value: 1000 },
		scrollHeight: { configurable: true, value: 5000 },
		clientWidth: { configurable: true, value: 400 },
		clientHeight: { configurable: true, value: 600 },
		offsetWidth: { configurable: true, value: 400 },
		offsetHeight: { configurable: true, value: 600 },
	});
	const contentElement = document.createElement('div');
	scrollElement.append(contentElement);
	document.body.append(scrollElement);
	const scrollToFn = vi.fn();
	const onChange = vi.fn();
	const stableOptions = {
		estimateSize: () => 50,
		getItemKey: (index: number) => keys[index] ?? `missing:${index}`,
		getScrollElement: () => scrollElement,
		onChange,
		scrollToFn,
		observeElementRect: (_instance, callback) => {
			callback({ width: 400, height: 600 });
			return () => {};
		},
		observeElementOffset: (_instance, callback) => {
			offsetCallback = callback;
			callback(0, false);
			return () => {};
		},
	} satisfies Omit<VirtualizerOptions<HTMLDivElement, HTMLElement>, 'count'>;
	const options = (): VirtualizerOptions<HTMLDivElement, HTMLElement> => ({
		...stableOptions,
		count: keys.length,
	});
	const virtualizer = new Virtualizer(options());
	virtualizer._willUpdate();
	const destroy = virtualizer._didMount();

	return {
		virtualizer,
		scrollElement,
		contentElement,
		scrollToFn,
		onChange,
		destroy,
		dispatchTouch(type, identifiers = []) {
			const event = new Event(type);
			Object.defineProperty(event, 'touches', {
				value: identifiers.map((identifier) => ({ identifier })),
			});
			scrollElement.dispatchEvent(event);
		},
		emitResize(node, height) {
			if (!resizeCallback) {
				throw new Error('The virtualizer did not create a ResizeObserver.');
			}
			const contentRect = new DOMRect(0, 0, 400, height);
			const entry = {
				target: node,
				contentRect,
				borderBoxSize: [{ blockSize: height, inlineSize: 400 }],
				contentBoxSize: [{ blockSize: height, inlineSize: 400 }],
				devicePixelContentBoxSize: [{ blockSize: height, inlineSize: 400 }],
			} satisfies ResizeObserverEntry;
			resizeCallback([entry], resizeObserver);
		},
		emitScrollOffset(offset, isScrolling = false) {
			if (!offsetCallback) throw new Error('The virtualizer did not observe scroll offsets.');
			offsetCallback(offset, isScrolling);
		},
		runAnimationFrames() {
			for (let iteration = 0; iteration < 20 && animationFrames.size > 0; iteration += 1) {
				const callbacks = [...animationFrames.values()];
				animationFrames.clear();
				for (const callback of callbacks) callback(performance.now());
			}
			if (animationFrames.size > 0) throw new Error('Virtualizer animation frames did not settle.');
		},
		setKeys(nextKeys) {
			keys = nextKeys;
			virtualizer.setOptions(options());
		},
	};
}

function configureIosWebKit(): void {
	vi.useFakeTimers();
	vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('iPhone');
	_resetIOSDetectionForTests();
}

function primeMeasuredRowAboveViewport(harness: VirtualizerHarness): void {
	harness.virtualizer.getVirtualItems();
	harness.virtualizer.resizeItem(0, 56);
	harness.virtualizer.getTotalSize();
	harness.emitScrollOffset(600, true);
	harness.emitScrollOffset(594, true);
	harness.scrollToFn.mockClear();
	harness.onChange.mockClear();
}

function createIosResizeHarness(configure = true): VirtualizerHarness {
	if (configure) configureIosWebKit();
	const harness = createVirtualizerHarness(
		Array.from({ length: 20 }, (_, index) => `item-${index}`),
	);
	primeMeasuredRowAboveViewport(harness);
	return harness;
}

afterEach(() => {
	_resetIOSDetectionForTests();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe('TanStack virtual-core patch contract', () => {
	it('lets direct measurement replace a connected element for the same key', () => {
		const { virtualizer } = createVirtualizerHarness(['only']);
		const first = virtualElement(0);
		const replacement = virtualElement(0);

		virtualizer.measureElement(first);
		virtualizer.measureElement(replacement);

		expect(virtualizer.elementsCache.get('only')).toBe(replacement);
	});

	it('ignores a delayed in-range resize whose index now resolves to another key', () => {
		const harness = createVirtualizerHarness(['removed', 'survivor']);
		const removed = virtualElement(0);
		const survivor = virtualElement(1);
		harness.virtualizer.measureElement(removed);
		harness.virtualizer.measureElement(survivor);
		harness.emitResize(survivor, 60);

		survivor.dataset.index = '0';
		harness.setKeys(['survivor']);
		harness.emitResize(removed, 900);

		expect(harness.virtualizer.itemSizeCache.get('survivor')).toBe(60);
	});

	it('compensates fully above-viewport shrinkage during backward scrolling', () => {
		const harness = createVirtualizerHarness(
			Array.from({ length: 20 }, (_, index) => `item-${index}`),
		);
		harness.virtualizer.getVirtualItems();
		harness.virtualizer.resizeItem(0, 56);
		harness.emitScrollOffset(600, true);
		harness.emitScrollOffset(594, true);
		expect(harness.virtualizer.scrollDirection).toBe('backward');
		harness.scrollToFn.mockClear();

		harness.virtualizer.resizeItem(0, 32);

		expect(harness.scrollToFn).toHaveBeenCalledOnce();
		expect(harness.scrollToFn.mock.calls[0]?.[1]).toMatchObject({ adjustments: -24 });

		harness.scrollToFn.mockClear();
		harness.virtualizer.resizeItem(0, 56);
		expect(harness.scrollToFn).not.toHaveBeenCalled();
	});

	it('cancels an armed reconciliation without restoring a later user offset', () => {
		const harness = createVirtualizerHarness(['only']);
		harness.scrollToFn.mockClear();
		harness.virtualizer.scrollToOffset(100);
		expect(harness.scrollToFn).toHaveBeenCalledOnce();

		harness.virtualizer.cancelScroll();
		harness.scrollToFn.mockClear();
		harness.emitScrollOffset(94, true);
		harness.runAnimationFrames();
		expect(harness.scrollToFn).not.toHaveBeenCalled();

		harness.virtualizer.scrollToOffset(160);
		expect(harness.scrollToFn).toHaveBeenCalledOnce();
		expect(harness.scrollToFn.mock.calls[0]?.[0]).toBe(160);
	});

	it('publishes growth and shrink geometry with equal CSS compensation during touch momentum', () => {
		const harness = createIosResizeHarness();
		const initialFollowerStart = harness.virtualizer.measurementsCache[1]?.start;
		const initialDistanceFromEnd = harness.virtualizer.getDistanceFromEnd();
		expect(initialFollowerStart).toBe(56);
		harness.dispatchTouch('touchstart', [1]);

		harness.virtualizer.resizeItem(0, 80);
		harness.virtualizer.getTotalSize();
		expect(harness.virtualizer.measurementsCache[1]?.start).toBe(80);
		expect(harness.contentElement.style.marginTop).toBe('-24px');
		expect((harness.virtualizer.measurementsCache[1]?.start ?? 0) - 24).toBe(initialFollowerStart);
		expect(harness.virtualizer.scrollOffset).toBe(618);
		expect(harness.virtualizer.getDistanceFromEnd()).toBe(initialDistanceFromEnd);
		expect(harness.scrollToFn).not.toHaveBeenCalled();
		expect(harness.onChange).toHaveBeenLastCalledWith(harness.virtualizer, true);

		harness.virtualizer.resizeItem(0, 44);
		harness.virtualizer.getTotalSize();
		expect(harness.virtualizer.measurementsCache[1]?.start).toBe(44);
		expect(harness.contentElement.style.marginTop).toBe('12px');
		expect((harness.virtualizer.measurementsCache[1]?.start ?? 0) + 12).toBe(initialFollowerStart);
		expect(harness.virtualizer.scrollOffset).toBe(582);
		expect(harness.virtualizer.getDistanceFromEnd()).toBe(initialDistanceFromEnd);
		expect(harness.scrollToFn).not.toHaveBeenCalled();
		expect(harness.onChange).toHaveBeenLastCalledWith(harness.virtualizer, true);
	});

	it('keeps programmatic scroll-event remeasurement synchronous without touch provenance', () => {
		const harness = createIosResizeHarness();
		harness.emitScrollOffset(600, true);

		harness.virtualizer.resizeItem(0, 76);

		expect(harness.contentElement.style.marginTop).toBe('');
		expect(harness.scrollToFn).toHaveBeenCalledOnce();
		expect(harness.scrollToFn.mock.calls[0]).toEqual([
			600,
			{ adjustments: 20, behavior: undefined },
			harness.virtualizer,
		]);
		expect(harness.onChange).toHaveBeenLastCalledWith(harness.virtualizer, true);
	});

	it('flushes accumulated CSS compensation exactly once after momentum settles', () => {
		const harness = createIosResizeHarness();
		harness.contentElement.style.setProperty('margin-top', '7px', 'important');
		harness.dispatchTouch('touchstart', [1]);
		harness.virtualizer.resizeItem(0, 76);
		expect(harness.contentElement.style.marginTop).toBe('calc(7px - 20px)');
		expect(harness.contentElement.style.getPropertyPriority('margin-top')).toBe('important');

		harness.dispatchTouch('touchend');
		harness.emitScrollOffset(594, false);
		expect(harness.scrollToFn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(151);

		expect(harness.contentElement.style.marginTop).toBe('7px');
		expect(harness.contentElement.style.getPropertyPriority('margin-top')).toBe('important');
		expect(harness.scrollToFn).toHaveBeenCalledOnce();
		expect(harness.scrollToFn.mock.calls[0]).toEqual([
			594,
			{ adjustments: 20, behavior: undefined },
			harness.virtualizer,
		]);
		expect(harness.virtualizer.scrollOffset).toBe(614);
	});

	it('lets absolute programmatic scrolls take over post-touch deviation', () => {
		const offsetHarness = createIosResizeHarness();
		offsetHarness.dispatchTouch('touchstart', [1]);
		offsetHarness.virtualizer.resizeItem(0, 76);
		offsetHarness.dispatchTouch('touchend');
		offsetHarness.scrollToFn.mockClear();

		offsetHarness.virtualizer.scrollToOffset(800);
		expect(offsetHarness.contentElement.style.marginTop).toBe('');
		expect(offsetHarness.scrollToFn).toHaveBeenCalledOnce();
		expect(offsetHarness.scrollToFn.mock.calls[0]?.[0]).toBe(800);
		offsetHarness.emitScrollOffset(800, true);
		offsetHarness.scrollToFn.mockClear();
		offsetHarness.virtualizer.resizeItem(0, 86);
		expect(offsetHarness.scrollToFn).toHaveBeenCalledOnce();
		expect(offsetHarness.contentElement.style.marginTop).toBe('');

		const indexHarness = createIosResizeHarness(false);
		indexHarness.dispatchTouch('touchstart', [1]);
		indexHarness.virtualizer.resizeItem(0, 76);
		indexHarness.dispatchTouch('touchend');
		indexHarness.scrollToFn.mockClear();
		indexHarness.virtualizer.scrollToIndex(10, { align: 'start' });
		expect(indexHarness.contentElement.style.marginTop).toBe('');
		expect(indexHarness.scrollToFn).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(151);
		expect(indexHarness.scrollToFn).toHaveBeenCalledOnce();
	});

	it('converts deviation and relative movement in one scrollBy write', () => {
		const harness = createIosResizeHarness();
		harness.dispatchTouch('touchstart', [1]);
		harness.virtualizer.resizeItem(0, 76);
		harness.dispatchTouch('touchend');
		harness.scrollToFn.mockClear();

		harness.virtualizer.scrollBy(30);

		expect(harness.contentElement.style.marginTop).toBe('');
		expect(harness.scrollToFn).toHaveBeenCalledOnce();
		expect(harness.scrollToFn.mock.calls[0]).toEqual([
			644,
			{ adjustments: undefined, behavior: 'auto' },
			harness.virtualizer,
		]);
	});

	it('preserves CSS compensation when user takeover cancels reconciliation', () => {
		const harness = createIosResizeHarness();
		harness.dispatchTouch('touchstart', [1]);
		harness.virtualizer.resizeItem(0, 76);
		harness.virtualizer.cancelScroll();

		expect(harness.contentElement.style.marginTop).toBe('-20px');
		harness.dispatchTouch('touchend');
		harness.emitScrollOffset(594, false);
		vi.advanceTimersByTime(151);
		expect(harness.contentElement.style.marginTop).toBe('');
		expect(harness.scrollToFn).toHaveBeenCalledOnce();
	});

	it('keeps multi-touch ownership through an intermediate finger lift', () => {
		const harness = createIosResizeHarness();
		harness.dispatchTouch('touchstart', [1, 2]);
		harness.virtualizer.resizeItem(0, 66);
		harness.dispatchTouch('touchend', [2]);
		vi.advanceTimersByTime(151);

		harness.virtualizer.resizeItem(0, 76);
		expect(harness.contentElement.style.marginTop).toBe('-20px');
		expect(harness.scrollToFn).not.toHaveBeenCalled();
		harness.dispatchTouch('touchend');
		harness.emitScrollOffset(594, false);
		vi.advanceTimersByTime(151);
		expect(harness.contentElement.style.marginTop).toBe('');
		expect(harness.scrollToFn).toHaveBeenCalledOnce();
	});

	it('releases touch ownership after touchcancel', () => {
		const harness = createIosResizeHarness();
		harness.dispatchTouch('touchstart', [1]);
		harness.virtualizer.resizeItem(0, 66);
		harness.dispatchTouch('touchcancel');
		harness.emitScrollOffset(594, false);
		vi.advanceTimersByTime(151);
		expect(harness.contentElement.style.marginTop).toBe('');
		harness.scrollToFn.mockClear();

		harness.emitScrollOffset(610, true);
		harness.virtualizer.resizeItem(0, 76);
		expect(harness.scrollToFn).toHaveBeenCalledOnce();
		expect(harness.contentElement.style.marginTop).toBe('');
	});

	it('does not latch touch provenance after a tap without scrolling', () => {
		const harness = createIosResizeHarness();
		harness.emitScrollOffset(594, false);
		harness.dispatchTouch('touchstart', [1]);
		harness.dispatchTouch('touchend');
		vi.advanceTimersByTime(151);
		harness.emitScrollOffset(600, true);

		harness.virtualizer.resizeItem(0, 76);
		expect(harness.scrollToFn).toHaveBeenCalledOnce();
		expect(harness.contentElement.style.marginTop).toBe('');
	});

	it('restores the original inline margin during cleanup', () => {
		const harness = createIosResizeHarness();
		harness.contentElement.style.setProperty('margin-top', '9px', 'important');
		harness.dispatchTouch('touchstart', [1]);
		harness.virtualizer.resizeItem(0, 76);
		expect(harness.contentElement.style.marginTop).toBe('calc(9px - 20px)');

		harness.destroy();

		expect(harness.contentElement.style.marginTop).toBe('9px');
		expect(harness.contentElement.style.getPropertyPriority('margin-top')).toBe('important');
	});
});
