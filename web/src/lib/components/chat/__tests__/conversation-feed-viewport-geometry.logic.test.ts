import { describe, expect, it } from 'vitest';
import type { VirtualItem } from '$lib/virt/virtual-list-types.js';
import {
	attainableConversationTargetOffset,
	classifyConversationVirtualStructure,
	classifyMeasuredConversationViewportFill,
	isConversationVirtualViewportCovered,
	retainedConversationRange,
	resolveConversationViewportRect,
	selectConversationReadingAnchor,
	shouldPreserveConversationVirtualEdge,
} from '../conversation-feed-viewport-geometry';

function virtualItem(key: string, index: number, start: number, size: number): VirtualItem {
	return { key, index, start, end: start + size, size };
}

describe('conversation virtual viewport geometry', () => {
	it('classifies identity, edge, interior, and unchanged geometry separately', () => {
		const base = {
			previousKeys: ['a', 'b', 'c'],
			previousEstimates: [10, 10, 10],
			nextKeys: ['a', 'b', 'c'],
			nextEstimates: [10, 10, 10],
		};

		expect(classifyConversationVirtualStructure({ ...base, identityChanged: true })).toBe(
			'identity',
		);
		expect(classifyConversationVirtualStructure({ ...base, identityChanged: false })).toBe('none');
		expect(
			classifyConversationVirtualStructure({
				...base,
				identityChanged: false,
				nextKeys: ['before', ...base.nextKeys],
				nextEstimates: [10, ...base.nextEstimates],
			}),
		).toBe('edge-qualified');
		expect(
			classifyConversationVirtualStructure({
				...base,
				identityChanged: false,
				nextEstimates: [10, 20, 10],
			}),
		).toBe('interior-only');
	});

	it('preserves only consumer-owned reading edges', () => {
		expect(
			shouldPreserveConversationVirtualEdge({
				structure: 'edge-qualified',
				endBehavior: 'preserve-reading-position',
				restorePolicyEnd: false,
			}),
		).toBe(true);
		expect(
			shouldPreserveConversationVirtualEdge({
				structure: 'edge-qualified',
				endBehavior: 'restore-if-pinned',
				restorePolicyEnd: true,
			}),
		).toBe(false);
		expect(
			shouldPreserveConversationVirtualEdge({
				structure: 'edge-qualified',
				endBehavior: 'explicit-navigation',
				restorePolicyEnd: false,
			}),
		).toBe(false);
	});

	it('selects the first intersecting eligible reading row', () => {
		const items = [
			virtualItem('spacer', 0, 0, 20),
			virtualItem('a', 1, 20, 40),
			virtualItem('b', 2, 60, 40),
		];

		expect(selectConversationReadingAnchor(items, 55, new Set(['a', 'b']))?.key).toBe('a');
		expect(selectConversationReadingAnchor(items, 61, new Set(['a', 'b']))?.key).toBe('b');
	});

	it('merges inclusive overscan, following, retained, and trailing indexes', () => {
		expect(retainedConversationRange({ startIndex: 2, endIndex: 3 }, 10, [0, 8], 7, 2)).toEqual([
			0, 2, 3, 4, 5, 7, 8, 9,
		]);
		expect(retainedConversationRange(null, 4, [1, 9])).toEqual([1]);
	});

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
			paintedOffset: 2_017,
			viewportSize: 758,
			sizerSize: 2_775,
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
				[virtualItem('first', 0, 0, 100), virtualItem('second', 1, 100, 132)],
				{ paintedOffset: 0, viewportSize: 758, sizerSize: 232 },
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
				{ paintedOffset: 500, viewportSize: 500, sizerSize: 1_100 },
			),
		).toBe(false);
	});

	it('classifies fill only after every row has a physical measurement', () => {
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b'],
				measuredSizes: new Map([['a', 80]]),
				viewportHeight: 100,
			}),
		).toBeNull();
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b'],
				measuredSizes: new Map([
					['a', 80],
					['b', 30],
				]),
				viewportHeight: 100,
			}),
		).toBe('overflow');
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b'],
				measuredSizes: new Map([
					['a', 40],
					['b', 30],
				]),
				viewportHeight: 100,
			}),
		).toBe('underfilled');
	});

	it('clamps targets and retains nonzero viewport rects', () => {
		expect(
			attainableConversationTargetOffset({
				currentOffset: 80,
				alignmentDelta: 50,
				maximumOffset: 100,
			}),
		).toBe(100);
		expect(
			resolveConversationViewportRect({ width: 40, height: 50 }, { width: 0, height: 0 }),
		).toEqual({ width: 40, height: 50 });
	});
});
