import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	measureVirtualRow,
	type VirtualRowMeasurementContext,
} from '../git-virtual-row-measurement.js';

function measurementContext(
	itemSizeCache: ReadonlyMap<string | number | bigint, number> = new Map(),
): VirtualRowMeasurementContext {
	return {
		indexFromElement: () => 7,
		options: { getItemKey: () => 'row-7' },
		itemSizeCache,
	} satisfies VirtualRowMeasurementContext;
}

function rowRect(height: number): DOMRect {
	return {
		x: 0,
		y: 0,
		width: 800,
		height,
		top: 0,
		right: 800,
		bottom: height,
		left: 0,
		toJSON: () => ({}),
	};
}

describe('measureVirtualRow', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('uses the observed block size without reading layout', () => {
		const element = document.createElement('div');
		const rect = vi.spyOn(element, 'getBoundingClientRect');
		const entry = {
			borderBoxSize: [{ blockSize: 63.5, inlineSize: 800 }],
		} satisfies Pick<ResizeObserverEntry, 'borderBoxSize'>;

		expect(measureVirtualRow(element, entry, measurementContext())).toBe(63.5);
		expect(rect).not.toHaveBeenCalled();
	});

	it('reuses a cached size without reading layout', () => {
		const element = document.createElement('div');
		const rect = vi.spyOn(element, 'getBoundingClientRect');
		const cache = new Map<string | number | bigint, number>([['row-7', 54]]);

		expect(measureVirtualRow(element, undefined, measurementContext(cache))).toBe(54);
		expect(rect).not.toHaveBeenCalled();
	});

	it('reads layout for the first measurement', () => {
		const element = document.createElement('div');
		vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rowRect(84));

		expect(measureVirtualRow(element, undefined, measurementContext())).toBe(84);
	});
});
