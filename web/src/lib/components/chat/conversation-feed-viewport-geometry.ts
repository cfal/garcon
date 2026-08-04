import { defaultRangeExtractor, type Range, type Rect } from '@tanstack/svelte-virtual';
import type { ConversationVirtualGeometrySnapshot } from './ConversationFeedProjectionState.svelte.js';

export const CHAT_GEOMETRY_END_THRESHOLD_PX = 1;

export type ConversationVirtualStructureChange =
	'none' | 'identity' | 'edge-qualified' | 'interior-only';

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function classifyConversationVirtualStructure(input: {
	identityChanged: boolean;
	previousKeys: readonly string[];
	previousEstimates: readonly number[];
	nextKeys: readonly string[];
	nextEstimates: readonly number[];
}): ConversationVirtualStructureChange {
	if (input.identityChanged) return 'identity';
	const keysChanged = !arraysEqual(input.previousKeys, input.nextKeys);
	const estimatesChanged = !arraysEqual(input.previousEstimates, input.nextEstimates);
	if (!keysChanged && !estimatesChanged) return 'none';
	if (
		input.previousKeys.length !== input.nextKeys.length ||
		input.previousKeys[0] !== input.nextKeys[0] ||
		input.previousKeys.at(-1) !== input.nextKeys.at(-1)
	) {
		return 'edge-qualified';
	}
	return 'interior-only';
}

export function shouldPreserveConversationVirtualEdge(input: {
	structure: ConversationVirtualStructureChange;
	endBehavior: ConversationVirtualGeometrySnapshot['endBehavior'];
	restorePolicyEnd: boolean;
}): boolean {
	return (
		input.structure === 'edge-qualified' &&
		input.endBehavior !== 'explicit-navigation' &&
		!input.restorePolicyEnd
	);
}

export function retainedConversationRange(
	range: Range,
	retainedIndexes: readonly number[],
	trailingStartIndex?: number,
): number[] {
	const indexes = new Set(defaultRangeExtractor(range));
	for (const index of retainedIndexes) {
		if (index >= 0 && index < range.count) indexes.add(index);
	}
	if (trailingStartIndex !== undefined) {
		for (let index = Math.max(0, trailingStartIndex); index < range.count; index += 1) {
			indexes.add(index);
		}
	}
	return [...indexes].sort((left, right) => left - right);
}

export function createRetainedConversationRangeExtractor(
	retainedIndexes: readonly number[],
	trailingStartIndex?: number,
): (range: Range) => number[] {
	return (range) => retainedConversationRange(range, retainedIndexes, trailingStartIndex);
}

export function classifyMeasuredConversationViewportFill(input: {
	keys: readonly string[];
	measuredSizes: { get(key: string): number | undefined };
	leadingSize: number;
	viewportHeight: number;
}): 'overflow' | 'underfilled' | null {
	let physicalSize = input.leadingSize;
	for (const key of input.keys) {
		const size = input.measuredSizes.get(key);
		if (size === undefined) return null;
		physicalSize += size;
		if (physicalSize > input.viewportHeight + CHAT_GEOMETRY_END_THRESHOLD_PX) {
			return 'overflow';
		}
	}
	return 'underfilled';
}

export function attainableConversationTargetOffset(input: {
	currentOffset: number;
	alignmentDelta: number;
	maximumOffset: number;
}): number {
	return Math.max(0, Math.min(input.maximumOffset, input.currentOffset + input.alignmentDelta));
}

export function resolveConversationViewportRect(previous: Rect, observed: Rect): Rect {
	// Retains the last geometry only while the viewport is fully collapsed.
	return observed.width > 0 && observed.height > 0 ? observed : previous;
}

export function isConversationTargetLayoutReady(node: HTMLElement): boolean {
	if (
		node.matches('[data-chat-layout-pending="true"]') ||
		node.querySelector('[data-chat-layout-pending="true"]')
	) {
		return false;
	}
	return Array.from(node.querySelectorAll('img')).every((image) => image.complete);
}
