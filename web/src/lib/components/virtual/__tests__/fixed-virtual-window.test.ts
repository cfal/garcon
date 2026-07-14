import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixedVirtualWindow, type FixedVirtualWindowOptions } from '../fixed-virtual-window.svelte';

function createViewport(initialHeight = 100) {
	let height = initialHeight;
	const element = document.createElement('div');
	Object.defineProperty(element, 'clientHeight', {
		configurable: true,
		get: () => height,
	});
	return {
		element,
		setHeight(next: number) {
			height = next;
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('FixedVirtualWindow', () => {
	it('calculates an overscanned half-open window at the top, middle, and end', () => {
		const virtualWindow = new FixedVirtualWindow({
			itemCount: 100,
			rowHeight: 20,
			overscan: 2,
			viewportRef: null,
			bottomPadding: 40,
			defaultViewportHeight: 100,
		});

		expect(virtualWindow.totalHeight).toBe(2040);
		expect(virtualWindow.startIndex).toBe(0);
		expect(virtualWindow.endIndex).toBe(7);
		expect(virtualWindow.visibleIndexes).toEqual([0, 1, 2, 3, 4, 5, 6]);

		virtualWindow.scrollTop = 85;
		expect(virtualWindow.startIndex).toBe(2);
		expect(virtualWindow.endIndex).toBe(12);
		expect(virtualWindow.visibleIndexes).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

		virtualWindow.scrollTop = 2_000;
		expect(virtualWindow.startIndex).toBe(98);
		expect(virtualWindow.endIndex).toBe(100);
		expect(virtualWindow.visibleIndexes).toEqual([98, 99]);
	});

	it('normalizes invalid dimensions and reads changing option getters', () => {
		let itemCount = -2;
		let rowHeight = 0;
		const options = {
			get itemCount() {
				return itemCount;
			},
			get rowHeight() {
				return rowHeight;
			},
			overscan: -3,
			bottomPadding: -10,
			viewportRef: null,
		} satisfies FixedVirtualWindowOptions;
		const virtualWindow = new FixedVirtualWindow(options);

		expect(virtualWindow.itemCount).toBe(0);
		expect(virtualWindow.rowHeight).toBe(1);
		expect(virtualWindow.overscan).toBe(0);
		expect(virtualWindow.bottomPadding).toBe(0);
		expect(virtualWindow.visibleIndexes).toEqual([]);

		itemCount = 3;
		rowHeight = 24;
		expect(virtualWindow.totalHeight).toBe(72);
		expect(virtualWindow.getOffset(2)).toBe(48);
	});

	it('binds scroll state and removes its listener during cleanup', () => {
		const viewport = createViewport(80);
		viewport.element.scrollTop = 30;
		const virtualWindow = new FixedVirtualWindow({
			itemCount: 20,
			rowHeight: 24,
			overscan: 1,
			viewportRef: viewport.element,
		});

		const cleanup = virtualWindow.bindViewport();
		expect(virtualWindow.scrollTop).toBe(30);
		expect(virtualWindow.viewportHeight).toBe(80);

		viewport.element.scrollTop = 70;
		viewport.element.dispatchEvent(new Event('scroll'));
		expect(virtualWindow.scrollTop).toBe(70);

		cleanup();
		viewport.element.scrollTop = 120;
		viewport.element.dispatchEvent(new Event('scroll'));
		expect(virtualWindow.scrollTop).toBe(70);
	});

	it('observes viewport height with a row-height floor and disconnects cleanly', () => {
		let callback!: ResizeObserverCallback;
		const observe = vi.fn();
		const disconnect = vi.fn();
		class TestResizeObserver {
			constructor(next: ResizeObserverCallback) {
				callback = next;
			}
			observe = observe;
			disconnect = disconnect;
			unobserve = vi.fn();
		}
		vi.stubGlobal('ResizeObserver', TestResizeObserver);
		const viewport = createViewport();
		const virtualWindow = new FixedVirtualWindow({
			itemCount: 10,
			rowHeight: 24,
			overscan: 0,
			viewportRef: viewport.element,
		});

		const cleanup = virtualWindow.observeViewport();
		expect(observe).toHaveBeenCalledWith(viewport.element);

		callback([{ contentRect: { height: 12 } } as ResizeObserverEntry], {} as ResizeObserver);
		expect(virtualWindow.viewportHeight).toBe(24);

		callback([{ contentRect: { height: 180 } } as ResizeObserverEntry], {} as ResizeObserver);
		expect(virtualWindow.viewportHeight).toBe(180);

		cleanup();
		expect(disconnect).toHaveBeenCalledOnce();
	});

	it('scrolls only offscreen valid indexes and applies the requested anchor', () => {
		const viewport = createViewport(100);
		viewport.element.scrollTop = 100;
		const virtualWindow = new FixedVirtualWindow({
			itemCount: 10,
			rowHeight: 20,
			overscan: 0,
			viewportRef: viewport.element,
		});
		virtualWindow.bindViewport();

		virtualWindow.scrollIndexIntoView(6);
		expect(viewport.element.scrollTop).toBe(100);

		virtualWindow.scrollIndexIntoView(2, 0.25);
		expect(viewport.element.scrollTop).toBe(15);
		expect(virtualWindow.scrollTop).toBe(15);

		virtualWindow.scrollIndexIntoView(9, 0.25);
		expect(viewport.element.scrollTop).toBe(155);

		virtualWindow.scrollIndexIntoView(-1);
		virtualWindow.scrollIndexIntoView(10);
		expect(viewport.element.scrollTop).toBe(155);
	});
});
