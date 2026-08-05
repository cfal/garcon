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

function conversationVirtualGeometryChangesBeforeAnchor(input: {
	previousKeys: readonly string[];
	previousEstimates: readonly number[];
	nextKeys: readonly string[];
	nextEstimates: readonly number[];
	anchorKey: string;
}): boolean {
	const previousAnchorIndex = input.previousKeys.indexOf(input.anchorKey);
	const nextAnchorIndex = input.nextKeys.indexOf(input.anchorKey);
	if (previousAnchorIndex < 0 || nextAnchorIndex < 0) return true;

	return (
		!arraysEqual(
			input.previousKeys.slice(0, previousAnchorIndex),
			input.nextKeys.slice(0, nextAnchorIndex),
		) ||
		!arraysEqual(
			input.previousEstimates.slice(0, previousAnchorIndex),
			input.nextEstimates.slice(0, nextAnchorIndex),
		)
	);
}

export function selectConversationReadingRestoreAnchor<T extends { key: string }>(input: {
	candidateAnchor: T | null;
	pendingAnchor: T | null;
	previous: Pick<ConversationVirtualGeometrySnapshot, 'keys' | 'estimates'>;
	next: Pick<ConversationVirtualGeometrySnapshot, 'keys' | 'estimates'>;
}): T | null {
	const anchor = input.candidateAnchor;
	if (!anchor) return null;
	// Avoids a redundant keyed restore when TanStack already anchors an unaffected tail append.
	const shouldRestore =
		input.pendingAnchor !== null ||
		conversationVirtualGeometryChangesBeforeAnchor({
			previousKeys: input.previous.keys,
			previousEstimates: input.previous.estimates,
			nextKeys: input.next.keys,
			nextEstimates: input.next.estimates,
			anchorKey: anchor.key,
		});
	return shouldRestore ? anchor : null;
}

export function selectConversationReadingAnchor<T extends { key: unknown; end: number }>(
	items: readonly T[],
	scrollOffset: number,
	eligibleKeys: ReadonlySet<string>,
): T | undefined {
	const eligibleItems = items.filter((item) => eligibleKeys.has(String(item.key)));
	return (
		eligibleItems.find((item) => item.end > scrollOffset + CHAT_GEOMETRY_END_THRESHOLD_PX) ??
		eligibleItems.at(-1)
	);
}

// Rejects a stale or disjoint range that could add a visible row after reveal.
export function isConversationVirtualViewportCovered(
	virtualItems: readonly { start: number; end: number }[],
	input: {
		scrollOffset: number;
		viewportSize: number;
		scrollMargin: number;
		totalSize: number;
	},
): boolean {
	const visibleStart = Math.max(input.scrollOffset, input.scrollMargin);
	const visibleEnd = Math.min(
		input.scrollOffset + input.viewportSize,
		input.scrollMargin + input.totalSize,
	);
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
	renderedKeys: { has(key: string): boolean };
	estimates: readonly number[];
	leadingSize: number;
	viewportHeight: number;
}): 'overflow' | 'underfilled' | null {
	let physicalSize = input.leadingSize;
	let allMeasured = true;
	for (const [index, key] of input.keys.entries()) {
		// TanStack omits a cache entry when a wrapper renders exactly at its estimate,
		// so a rendered key without a cache entry is measured at that estimate.
		const size =
			input.measuredSizes.get(key) ??
			(input.renderedKeys.has(key) ? input.estimates[index] : undefined);
		if (size === undefined) {
			allMeasured = false;
			physicalSize = 0;
			continue;
		}
		physicalSize += size;
		if (physicalSize > input.viewportHeight + CHAT_GEOMETRY_END_THRESHOLD_PX) {
			return 'overflow';
		}
	}
	return allMeasured ? 'underfilled' : null;
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
