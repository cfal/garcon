import { Virtualizer, type VirtualizerOptions } from '@tanstack/virtual-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface VirtualizerHarness {
	virtualizer: Virtualizer<HTMLDivElement, HTMLElement>;
	emitResize(node: HTMLElement, height: number): void;
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
	const stableOptions = {
		estimateSize: () => 50,
		getItemKey: (index: number) => keys[index] ?? `missing:${index}`,
		getScrollElement: () => scrollElement,
		scrollToFn: vi.fn(),
		observeElementRect: (_instance, callback) => {
			callback({ width: 400, height: 600 });
			return () => {};
		},
		observeElementOffset: (_instance, callback) => {
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
		setKeys(nextKeys) {
			keys = nextKeys;
			virtualizer.setOptions(options());
		},
	};
}

afterEach(() => {
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
});
