import { describe, expect, it } from 'vitest';
import {
	calculateFitScale,
	captureZoomAnchor,
	distance,
	midpoint,
	restoreZoomAnchor,
} from '../zoom-viewport';

describe('zoom viewport geometry', () => {
	it('fits content against both viewport dimensions without upscaling', () => {
		expect(
			calculateFitScale({
				viewport: { width: 1000, height: 500 },
				content: { width: 2000, height: 400 },
				padding: 20,
				minScale: 0.25,
				maxScale: 5,
			}),
		).toBeCloseTo(0.48);
		expect(
			calculateFitScale({
				viewport: { width: 1000, height: 500 },
				content: { width: 200, height: 100 },
				padding: 20,
				minScale: 0.25,
				maxScale: 5,
			}),
		).toBe(1);
		expect(
			calculateFitScale({
				viewport: { width: 310, height: 500 },
				content: { width: 1_000_000, height: 100 },
				padding: 20,
				minScale: 0,
				maxScale: 5,
			}),
		).toBeCloseTo(0.00027);
	});

	it('preserves a client-anchored focal point after zoom', () => {
		const anchor = captureZoomAnchor(
			{ left: 0, top: 0, width: 500, height: 400 },
			{ left: 100, top: 50, width: 400, height: 200 },
			{ x: 300, y: 100 },
		);
		const viewport = { scrollLeft: 40, scrollTop: 30 };
		restoreZoomAnchor(viewport, { left: 50, top: 25, width: 800, height: 400 }, anchor);

		expect(anchor.focal).toEqual({ x: 0.5, y: 0.25 });
		expect(viewport).toEqual({ scrollLeft: 190, scrollTop: 55 });
	});

	it('calculates pinch midpoint and distance', () => {
		expect(midpoint({ x: 20, y: 40 }, { x: 80, y: 100 })).toEqual({ x: 50, y: 70 });
		expect(distance({ x: 0, y: 0 }, { x: 30, y: 40 })).toBe(50);
	});
});
