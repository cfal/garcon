import { describe, expect, it } from 'vitest';
import {
	classifyMeasuredConversationViewportFill,
	classifyConversationVirtualStructure,
	attainableConversationTargetOffset,
	retainedConversationRange,
	shouldPreserveConversationVirtualEdge,
} from '../ConversationFeedVirtualController.svelte';

describe('ConversationFeedVirtualController helpers', () => {
	it('classifies identity, edge, estimate-only, and no-op changes', () => {
		expect(
			classifyConversationVirtualStructure({
				identityChanged: true,
				previousKeys: ['a'],
				previousEstimates: [10],
				nextKeys: ['a'],
				nextEstimates: [10],
			}),
		).toBe('identity');
		expect(
			classifyConversationVirtualStructure({
				identityChanged: false,
				previousKeys: ['b'],
				previousEstimates: [10],
				nextKeys: ['a', 'b'],
				nextEstimates: [10, 10],
			}),
		).toBe('edge-qualified');
		expect(
			classifyConversationVirtualStructure({
				identityChanged: false,
				previousKeys: ['a', 'b', 'c'],
				previousEstimates: [10, 10, 10],
				nextKeys: ['a', 'x', 'c'],
				nextEstimates: [10, 10, 10],
			}),
		).toBe('interior-only');
		expect(
			classifyConversationVirtualStructure({
				identityChanged: false,
				previousKeys: ['a'],
				previousEstimates: [10],
				nextKeys: ['a'],
				nextEstimates: [10],
			}),
		).toBe('none');
	});

	it('adds sorted, valid retained indexes to a possibly disjoint range', () => {
		expect(
			retainedConversationRange(
				{ startIndex: 4, endIndex: 6, overscan: 0, count: 10 },
				[9, 1, 5, -1, 12],
			),
		).toEqual([1, 4, 5, 6, 9]);
	});

	it('preserves detached edge changes without overriding pinned or navigation policy', () => {
		expect(
			shouldPreserveConversationVirtualEdge({
				structure: 'edge-qualified',
				endBehavior: 'restore-if-pinned',
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

	it('reports fill only from a contiguous measured physical prefix', () => {
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b'],
				measuredSizes: new Map([['a', 300]]),
				leadingSize: 16,
				viewportHeight: 400,
			}),
		).toBeNull();
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b'],
				measuredSizes: new Map([
					['a', 300],
					['b', 120],
				]),
				leadingSize: 16,
				viewportHeight: 400,
			}),
		).toBe('overflow');
		expect(
			classifyMeasuredConversationViewportFill({
				keys: ['a', 'b'],
				measuredSizes: new Map([
					['a', 100],
					['b', 120],
				]),
				leadingSize: 16,
				viewportHeight: 400,
			}),
		).toBe('underfilled');
	});

	it('clamps target alignment to attainable scroll boundaries', () => {
		expect(
			attainableConversationTargetOffset({
				currentOffset: 0,
				alignmentDelta: -120,
				maximumOffset: 900,
			}),
		).toBe(0);
		expect(
			attainableConversationTargetOffset({
				currentOffset: 850,
				alignmentDelta: 100,
				maximumOffset: 900,
			}),
		).toBe(900);
		expect(
			attainableConversationTargetOffset({
				currentOffset: 300,
				alignmentDelta: 75,
				maximumOffset: 900,
			}),
		).toBe(375);
	});
});
