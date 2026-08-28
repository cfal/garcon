import type { VirtualRange } from '$lib/virt/virtual-list-types.js';
import type { ConversationVirtualGeometrySnapshot } from './ConversationFeedProjectionState.svelte.js';

export const CHAT_GEOMETRY_END_THRESHOLD_PX = 1;
export const CHAT_VIRTUAL_FOLLOWING_BUFFER_ROWS = 12;

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

// Rejects a stale or disjoint range that could add a visible row after reveal.
export function isConversationVirtualViewportCovered(
	virtualItems: readonly { start: number; end: number }[],
	input: {
		paintedOffset: number;
		viewportSize: number;
		sizerSize: number;
	},
): boolean {
	const visibleStart = Math.max(input.paintedOffset, 0);
	const visibleEnd = Math.min(input.paintedOffset + input.viewportSize, input.sizerSize);
	if (visibleEnd <= visibleStart + CHAT_GEOMETRY_END_THRESHOLD_PX) return true;

	let coveredThrough = visibleStart;
	for (const item of virtualItems) {
		if (item.end < coveredThrough - CHAT_GEOMETRY_END_THRESHOLD_PX) continue;
		if (item.start > coveredThrough + CHAT_GEOMETRY_END_THRESHOLD_PX) return false;
		coveredThrough = Math.max(coveredThrough, item.end);
		if (coveredThrough >= visibleEnd - CHAT_GEOMETRY_END_THRESHOLD_PX) return true;
	}
	return false;
}

export function retainedConversationRange(input: {
	readonly overscanRange: VirtualRange | null;
	readonly visibleRange: VirtualRange | null;
	readonly count: number;
	readonly retainedIndexes: readonly number[];
	readonly trailingStartIndex?: number | null;
	readonly followingRowCount?: number;
}): number[] {
	const {
		overscanRange,
		visibleRange,
		count,
		retainedIndexes,
		trailingStartIndex = null,
		followingRowCount = 0,
	} = input;
	const indexes = new Set<number>();
	if (overscanRange) {
		for (let index = overscanRange.startIndex; index <= overscanRange.endIndex; index += 1) {
			indexes.add(index);
		}
	}
	if (visibleRange) {
		const followingEndIndex = Math.min(count - 1, visibleRange.endIndex + followingRowCount);
		for (let index = visibleRange.endIndex + 1; index <= followingEndIndex; index += 1) {
			indexes.add(index);
		}
	}
	for (const index of retainedIndexes) {
		if (index >= 0 && index < count) indexes.add(index);
	}
	if (trailingStartIndex !== null) {
		for (let index = Math.max(0, trailingStartIndex); index < count; index += 1) {
			indexes.add(index);
		}
	}
	return [...indexes].sort((left, right) => left - right);
}

export function classifyMeasuredConversationViewportFill(input: {
	keys: readonly string[];
	measuredSizes: { get(key: string): number | undefined };
	viewportHeight: number;
}): 'overflow' | 'underfilled' | null {
	let physicalSize = 0;
	for (const key of input.keys) {
		const size = input.measuredSizes.get(key);
		if (size === undefined) {
			continue;
		}
		physicalSize += size;
		if (physicalSize > input.viewportHeight + CHAT_GEOMETRY_END_THRESHOLD_PX) {
			return 'overflow';
		}
	}
	return input.keys.every((key) => input.measuredSizes.get(key) !== undefined)
		? 'underfilled'
		: null;
}

export function attainableConversationTargetOffset(input: {
	currentOffset: number;
	alignmentDelta: number;
	maximumOffset: number;
}): number {
	return Math.max(0, Math.min(input.maximumOffset, input.currentOffset + input.alignmentDelta));
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
