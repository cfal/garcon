// Chart geometry in a fixed view box; the SVG scales to its container without preserving ratio.
export const CHART_VIEW_WIDTH = 960;
export const CHART_VIEW_HEIGHT = 260;
const PLOT_TOP = 8;

export interface UsageChartSeries {
	readonly id: string;
	readonly label: string;
	readonly color: string;
	// One value per charted day.
	readonly values: readonly number[];
}

export interface ChartScale {
	readonly max: number;
	readonly ticks: readonly number[];
}

interface Point {
	readonly x: number;
	readonly y: number;
}

/** Rounds the peak up to a 1-2-5 step so axis labels stay readable. */
export function niceScale(peak: number, tickCount = 4): ChartScale {
	if (!(peak > 0)) return { max: 0, ticks: [0] };
	const rawStep = peak / tickCount;
	const magnitude = 10 ** Math.floor(Math.log10(rawStep));
	const normalized = rawStep / magnitude;
	const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
	const max = Math.ceil(peak / step) * step;
	const ticks: number[] = [];
	for (let index = 0; index * step <= max + step * 1e-6; index += 1) ticks.push(index * step);
	return { max, ticks };
}

export function valueToY(value: number, max: number): number {
	return max === 0
		? CHART_VIEW_HEIGHT
		: CHART_VIEW_HEIGHT - (value / max) * (CHART_VIEW_HEIGHT - PLOT_TOP);
}

export function indexToX(index: number, count: number): number {
	return count < 2 ? CHART_VIEW_WIDTH / 2 : (index * CHART_VIEW_WIDTH) / (count - 1);
}

// Fritsch-Carlson tangents keep the curve monotone between points, so it never
// overshoots below zero or above a day's actual value.
function monotoneTangents(points: readonly Point[]): number[] {
	const count = points.length;
	const slopes: number[] = [];
	for (let index = 0; index < count - 1; index += 1) {
		const dx = points[index + 1]!.x - points[index]!.x;
		slopes.push(dx === 0 ? 0 : (points[index + 1]!.y - points[index]!.y) / dx);
	}
	const tangents = Array.from({ length: count }, () => 0);
	tangents[0] = slopes[0] ?? 0;
	tangents[count - 1] = slopes[count - 2] ?? 0;
	for (let index = 1; index < count - 1; index += 1) {
		const previous = slopes[index - 1]!;
		const next = slopes[index]!;
		tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
	}
	for (let index = 0; index < count - 1; index += 1) {
		const slope = slopes[index]!;
		if (slope === 0) {
			tangents[index] = 0;
			tangents[index + 1] = 0;
			continue;
		}
		const a = tangents[index]! / slope;
		const b = tangents[index + 1]! / slope;
		const magnitude = a * a + b * b;
		if (magnitude > 9) {
			const scale = 3 / Math.sqrt(magnitude);
			tangents[index] = scale * a * slope;
			tangents[index + 1] = scale * b * slope;
		}
	}
	return tangents;
}

const coordinate = (value: number) => value.toFixed(2);

/** Smooth line and filled area for one series, in view-box coordinates. */
export function seriesPaths(
	values: readonly number[],
	max: number,
): { readonly line: string; readonly area: string } {
	const points = values.map((value, index) => ({
		x: indexToX(index, values.length),
		y: valueToY(value, max),
	}));
	if (points.length === 0) return { line: '', area: '' };
	if (points.length === 1) {
		const y = coordinate(points[0]!.y);
		const line = `M0,${y} L${CHART_VIEW_WIDTH},${y}`;
		return {
			line,
			area: `${line} L${CHART_VIEW_WIDTH},${CHART_VIEW_HEIGHT} L0,${CHART_VIEW_HEIGHT} Z`,
		};
	}
	const tangents = monotoneTangents(points);
	let line = `M${coordinate(points[0]!.x)},${coordinate(points[0]!.y)}`;
	for (let index = 0; index < points.length - 1; index += 1) {
		const from = points[index]!;
		const to = points[index + 1]!;
		const dx = to.x - from.x;
		line +=
			` C${coordinate(from.x + dx / 3)},${coordinate(from.y + (tangents[index]! * dx) / 3)}` +
			` ${coordinate(to.x - dx / 3)},${coordinate(to.y - (tangents[index + 1]! * dx) / 3)}` +
			` ${coordinate(to.x)},${coordinate(to.y)}`;
	}
	return {
		line,
		area: `${line} L${CHART_VIEW_WIDTH},${CHART_VIEW_HEIGHT} L0,${CHART_VIEW_HEIGHT} Z`,
	};
}

/** Nearest data index for a pointer position across the plot's width. */
export function indexAtFraction(fraction: number, count: number): number {
	if (count <= 1) return 0;
	return Math.min(count - 1, Math.max(0, Math.round(fraction * (count - 1))));
}
