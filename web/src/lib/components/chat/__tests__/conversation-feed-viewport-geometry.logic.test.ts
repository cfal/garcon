import type { VirtualItem } from '@tanstack/svelte-virtual';
import { describe, expect, it } from 'vitest';
import { isConversationVirtualViewportCovered } from '../conversation-feed-viewport-geometry';

function virtualItem(key: string, index: number, start: number, size: number): VirtualItem {
	return { key, index, start, end: start + size, size, lane: 0 };
}

describe('conversation virtual viewport geometry', () => {
	it('keeps a switched feed concealed while its committed range leaves visible space uncovered', () => {
		const staleRange = [
			virtualItem('seq-29', 29, 2_136.984_375, 58),
			virtualItem('bash-8', 30, 2_194.984_375, 68.5),
			virtualItem('seq-32', 31, 2_263.484_375, 163.984_375),
			virtualItem('seq-33', 32, 2_427.468_75, 58),
			virtualItem('bash-9', 33, 2_485.468_75, 68.5),
			virtualItem('seq-36', 34, 2_553.968_75, 164.031_25),
			virtualItem('end-spacer', 35, 2_718, 57),
		];
		const viewport = {
			scrollOffset: 2_017,
			viewportSize: 758,
			scrollMargin: 0,
			totalSize: 2_775,
		};

		expect(isConversationVirtualViewportCovered(staleRange, viewport)).toBe(false);
		expect(
			isConversationVirtualViewportCovered(
				[virtualItem('seq-28', 28, 1_905, 231.984_375), ...staleRange],
				viewport,
			),
		).toBe(true);
	});

	it('accepts an underfilled list after all visible list content commits', () => {
		expect(
			isConversationVirtualViewportCovered(
				[virtualItem('first', 0, 60, 100), virtualItem('second', 1, 160, 132)],
				{ scrollOffset: 0, viewportSize: 758, scrollMargin: 60, totalSize: 232 },
			),
		).toBe(true);
	});

	it('rejects disjoint retained rows that bracket an uncovered viewport', () => {
		expect(
			isConversationVirtualViewportCovered(
				[
					virtualItem('retained-start', 0, 0, 100),
					virtualItem('visible-start', 5, 500, 100),
					virtualItem('retained-end', 10, 1_000, 100),
				],
				{ scrollOffset: 500, viewportSize: 500, scrollMargin: 0, totalSize: 1_100 },
			),
		).toBe(false);
	});
});
