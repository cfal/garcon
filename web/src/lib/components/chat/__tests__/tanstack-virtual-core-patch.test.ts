import {
	_resetIOSDetectionForTests,
	Virtualizer,
	type VirtualizerOptions,
} from '@tanstack/virtual-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface VirtualizerHarness {
	virtualizer: Virtualizer<HTMLDivElement, HTMLElement>;
	scrollElement: HTMLDivElement;
	scrollToFn: ReturnType<typeof vi.fn>;
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
		offsetWidth: { configurable: true, value: 400 },
		offsetHeight: { configurable: true, value: 600 },
	});
	document.body.append(scrollElement);
	const scrollToFn = vi.fn();
	const stableOptions = {
		estimateSize: () => 50,
		getItemKey: (index: number) => keys[index] ?? `missing:${index}`,
		getScrollElement: () => scrollElement,
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

	return {
		virtualizer,
		scrollElement,
		scrollToFn,
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

	it('discards an iOS adjustment deferred before user ownership', () => {
		vi.useFakeTimers();
		vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('iPhone');
		_resetIOSDetectionForTests();
		const harness = createVirtualizerHarness(['only']);
		harness.virtualizer.getVirtualItems();
		harness.emitScrollOffset(100);
		harness.scrollElement.dispatchEvent(new Event('touchstart'));
		harness.scrollToFn.mockClear();

		harness.virtualizer.resizeItem(0, 60);
		expect(harness.scrollToFn).not.toHaveBeenCalled();
		harness.scrollElement.dispatchEvent(new Event('touchend'));
		vi.advanceTimersByTime(151);
		expect(harness.scrollToFn).toHaveBeenCalledOnce();
		harness.emitScrollOffset(110);

		harness.scrollElement.dispatchEvent(new Event('touchstart'));
		harness.scrollToFn.mockClear();
		harness.virtualizer.resizeItem(0, 70);
		expect(harness.scrollToFn).not.toHaveBeenCalled();
		harness.virtualizer.cancelScroll();
		harness.scrollElement.dispatchEvent(new Event('touchend'));
		vi.advanceTimersByTime(151);

		expect(harness.scrollToFn).not.toHaveBeenCalled();
	});
});
