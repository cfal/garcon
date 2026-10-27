import { describe, expect, it } from 'vitest';
import {
	CHART_VIEW_HEIGHT,
	CHART_VIEW_WIDTH,
	indexAtFraction,
	indexToX,
	niceScale,
	seriesPaths,
	valueToY,
} from '../usage-chart-geometry';

function pathPoints(path: string): number[][] {
	return [...path.matchAll(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g)].map((match) =>
		match[0].split(',').map(Number),
	);
}

describe('usage chart geometry', () => {
	it('rounds the peak up to a 1-2-5 step', () => {
		expect(niceScale(0)).toEqual({ max: 0, ticks: [0] });
		expect(niceScale(2_830)).toEqual({ max: 3_000, ticks: [0, 1_000, 2_000, 3_000] });
		expect(niceScale(27.4)).toEqual({ max: 30, ticks: [0, 10, 20, 30] });
		expect(niceScale(0.42).ticks.at(-1)).toBeCloseTo(0.6, 10);
		expect(niceScale(0.42).ticks).toHaveLength(4);
	});

	it('maps values and indexes into the view box', () => {
		expect(valueToY(0, 30)).toBe(CHART_VIEW_HEIGHT);
		expect(valueToY(30, 30)).toBe(8);
		expect(valueToY(5, 0)).toBe(CHART_VIEW_HEIGHT);
		expect(indexToX(0, 7)).toBe(0);
		expect(indexToX(6, 7)).toBe(CHART_VIEW_WIDTH);
		expect(indexToX(0, 1)).toBe(CHART_VIEW_WIDTH / 2);
		expect(indexAtFraction(0.49, 3)).toBe(1);
		expect(indexAtFraction(1.5, 3)).toBe(2);
		expect(indexAtFraction(0.5, 1)).toBe(0);
	});

	it('draws a monotone curve that never leaves the plot', () => {
		const { line, area } = seriesPaths([0, 10, 0, 30, 30, 0], 30);
		expect(line.startsWith('M0.00,260.00')).toBe(true);
		expect(
			area.endsWith(`L${CHART_VIEW_WIDTH},${CHART_VIEW_HEIGHT} L0,${CHART_VIEW_HEIGHT} Z`),
		).toBe(true);
		for (const [, y] of pathPoints(line)) {
			expect(y).toBeGreaterThanOrEqual(8 - 1e-6);
			expect(y).toBeLessThanOrEqual(CHART_VIEW_HEIGHT + 1e-6);
		}
	});

	it('draws a flat line for a single day and nothing for no days', () => {
		expect(seriesPaths([5], 10).line).toBe(
			`M0,${valueToY(5, 10).toFixed(2)} L${CHART_VIEW_WIDTH},${valueToY(5, 10).toFixed(2)}`,
		);
		expect(seriesPaths([], 10)).toEqual({ line: '', area: '' });
	});
});
