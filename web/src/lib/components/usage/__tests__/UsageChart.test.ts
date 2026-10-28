import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import UsageChart from '../UsageChart.svelte';

afterEach(cleanup);

// Hovers the chart at a fraction of its plot width; jsdom has no layout, so the plot reports a fixed box.
async function hoverAt(fraction: number): Promise<HTMLElement> {
	const plot = document.querySelector<HTMLElement>('[data-usage-chart] [role="presentation"]')!;
	plot.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
	await fireEvent.pointerMove(plot, { clientX: 400 * fraction, clientY: 100 });
	return document.querySelector<HTMLElement>('[data-usage-chart-tooltip]')!;
}

describe('UsageChart', () => {
	const days = ['2026-10-25', '2026-10-26', '2026-10-27'];
	const format = (value: number) => `$${value.toFixed(2)}`;
	const renderChart = (unknownOther: readonly boolean[]) =>
		render(UsageChart, {
			days,
			series: [
				{ id: 'a', label: 'Claude', color: 'red', values: [1, 0, 2], unknown: [false, true, false] },
				{ id: 'b', label: 'Codex', color: 'blue', values: [3, 0, 0], unknown: unknownOther },
			],
			format,
			formatAxis: format,
			ariaLabel: 'Daily cost',
			unknownLabel: 'Unpriced',
		});

	it('shows unknown points and an all-unknown total with the unknown label', async () => {
		renderChart([false, true, false]);
		const tooltip = await hoverAt(0.5);
		expect(tooltip.textContent).not.toContain('$0.00');
		expect(tooltip.textContent?.match(/Unpriced/g)).toHaveLength(3);
	});

	it('totals the known points of a day that also has unknown ones', async () => {
		renderChart([false, false, false]);
		const tooltip = await hoverAt(0.5);
		expect(tooltip.textContent?.match(/Unpriced/g)).toHaveLength(1);
		expect(tooltip.textContent).toContain('$0.00');
	});
});
