import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureVirtualRow } from '../git-virtual-row-measurement.js';

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

		expect(measureVirtualRow(element, entry)).toBe(63.5);
		expect(rect).not.toHaveBeenCalled();
	});

	it('reads layout when an observer entry omits its border box', () => {
		const element = document.createElement('div');
		const rect = vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rowRect(84));
		const entry = {
			borderBoxSize: [],
		} satisfies Pick<ResizeObserverEntry, 'borderBoxSize'>;

		expect(measureVirtualRow(element, entry)).toBe(84);
		expect(rect).toHaveBeenCalledOnce();
	});

	it('reads layout for the first measurement', () => {
		const element = document.createElement('div');
		vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rowRect(84));

		expect(measureVirtualRow(element, undefined)).toBe(84);
	});
});
