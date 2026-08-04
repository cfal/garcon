import { describe, expect, it } from 'vitest';
import {
	classifyMeasuredConversationViewportFill,
	classifyConversationVirtualStructure,
	attainableConversationTargetOffset,
	createRetainedConversationRangeExtractor,
	isConversationTargetLayoutReady,
	retainedConversationRange,
	resolveConversationViewportRect,
	shouldPreserveConversationVirtualEdge,
} from '../conversation-feed-viewport-geometry';

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

	it('retains the pinned transcript tail and its trailing surface', () => {
		expect(
			retainedConversationRange({ startIndex: 1, endIndex: 2, overscan: 0, count: 10 }, [], 7),
		).toEqual([1, 2, 7, 8, 9]);
	});

	it('publishes a fresh range extractor when retention policy changes', () => {
		const first = createRetainedConversationRangeExtractor([], 7);
		const second = createRetainedConversationRangeExtractor([0], 7);
		const range = { startIndex: 2, endIndex: 3, overscan: 0, count: 10 };

		expect(second).not.toBe(first);
		expect(first(range)).toEqual([2, 3, 7, 8, 9]);
		expect(second(range)).toEqual([0, 2, 3, 7, 8, 9]);
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

	it('retains the last usable viewport rect across pathological observations', () => {
		const previous = { width: 1_024, height: 720 };
		expect(resolveConversationViewportRect(previous, { width: 5, height: 5 })).toEqual({
			width: 5,
			height: 5,
		});
		expect(resolveConversationViewportRect(previous, { width: 0, height: 600 })).toBe(previous);
		expect(resolveConversationViewportRect(previous, { width: 390, height: 24 })).toEqual({
			width: 390,
			height: 24,
		});
	});

	it('waits for pending rich content and image dimensions before settling a target', () => {
		const row = document.createElement('div');
		const pending = document.createElement('div');
		pending.dataset.chatLayoutPending = 'true';
		row.append(pending);
		expect(isConversationTargetLayoutReady(row)).toBe(false);

		pending.dataset.chatLayoutPending = 'false';
		const image = document.createElement('img');
		Object.defineProperty(image, 'complete', { configurable: true, value: false });
		row.append(image);
		expect(isConversationTargetLayoutReady(row)).toBe(false);

		Object.defineProperty(image, 'complete', { configurable: true, value: true });
		expect(isConversationTargetLayoutReady(row)).toBe(true);
	});
});
