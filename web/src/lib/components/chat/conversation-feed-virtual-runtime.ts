import { tick } from 'svelte';
import type {
	VirtualItem,
	VirtualListSnapshot,
	VirtualViewportPosition,
} from '$lib/virt/virtual-list-types.js';
import {
	attainableConversationTargetOffset,
	CHAT_GEOMETRY_END_THRESHOLD_PX,
	classifyMeasuredConversationViewportFill,
	isConversationTargetLayoutReady,
	isConversationVirtualViewportCovered,
	selectConversationReadingAnchor,
} from './conversation-feed-viewport-geometry.js';

const HIDDEN_ANCHOR_FALLBACK_RADIUS = 8;
const MAX_END_RESTORE_ITERATIONS = 60;
const MAX_EARLY_END_RESTORE_ITERATIONS = 8;
const MAX_TARGET_SETTLE_ITERATIONS = 180;
const REQUIRED_END_STABLE_FRAMES = 2;
const GEOMETRY_TOLERANCE_PX = 0.5;

export interface ConversationVirtualAnchor {
	key: string;
	viewportOffset: number;
	fallbackKeys: readonly string[];
}

export class ConversationEarlierPrependAnchorOwnership {
	#anchor: ConversationVirtualAnchor | null = null;
	#clamped = false;
	#publicationBeganClamped = false;
	#blocksScrollbarDrag = false;
	#retainedMountedRowKeys: Set<string> | null = null;

	clear(): void {
		this.#anchor = null;
		this.#clamped = false;
		this.#publicationBeganClamped = false;
		this.#blocksScrollbarDrag = false;
		this.#retainedMountedRowKeys = null;
	}

	beginMountedRowRetention(
		keys: Iterable<string>,
		beganClamped = false,
		scrollbarDragActive = false,
	): void {
		this.#retainedMountedRowKeys = new Set(keys);
		this.#publicationBeganClamped = beganClamped;
		this.#blocksScrollbarDrag ||= beganClamped && scrollbarDragActive;
	}

	retainMountedRow(key: string): void {
		this.#retainedMountedRowKeys?.add(key);
	}

	retainedIndexes(base: readonly number[], indexByKey: ReadonlyMap<string, number>): number[] {
		const indexes = [...base];
		for (const key of this.#retainedMountedRowKeys ?? []) {
			const index = indexByKey.get(key);
			if (index !== undefined) indexes.push(index);
		}
		return indexes;
	}

	carry(anchor: ConversationVirtualAnchor | null, isEarlierPublication: boolean): void {
		if (!anchor) {
			this.clear();
			return;
		}
		if (isEarlierPublication) {
			if (this.#anchor !== anchor) this.#clamped = this.#publicationBeganClamped;
			else if (this.#publicationBeganClamped) this.#clamped = true;
			this.#publicationBeganClamped = false;
			this.#anchor = anchor;
		} else if (this.#anchor?.key !== anchor.key) {
			this.clear();
		}
	}

	preserves(
		direction: 'earlier' | 'later' | null,
		position: { distanceFromStart: number; leadingContentReachable: boolean } | null,
		source: 'viewport' | 'scrollbar-drag' = 'viewport',
	): boolean {
		if (source === 'scrollbar-drag' && this.#blocksScrollbarDrag) {
			if (direction !== 'later') return true;
			this.#blocksScrollbarDrag = false;
		}
		if (!this.#anchor) return this.#publicationBeganClamped && direction !== 'later';
		if (direction === null) return true;
		if (direction !== 'earlier') return false;
		const atLeadingWall = Boolean(
			position &&
			(!position.leadingContentReachable ||
				position.distanceFromStart <= CHAT_GEOMETRY_END_THRESHOLD_PX),
		);
		if (!this.#clamped && !atLeadingWall) return false;
		this.#clamped = true;
		return true;
	}

	blocksViewportMutation(source: 'viewport' | 'scrollbar-drag'): boolean {
		return source === 'scrollbar-drag' && this.#blocksScrollbarDrag;
	}

	finishScrollbarDrag(): void {
		this.#blocksScrollbarDrag = false;
	}
}

export class ConversationMountedVirtualItems {
	#elements = new Set<HTMLDivElement>();

	add(element: HTMLDivElement): void {
		this.#elements.add(element);
	}

	delete(element: HTMLDivElement): void {
		this.#elements.delete(element);
	}

	clear(): void {
		this.#elements.clear();
	}

	transcriptKeys(
		configuredKeys: readonly string[],
		eligibleKeys: ReadonlySet<string>,
	): ReadonlySet<string> {
		const keys = new Set<string>();
		for (const key of this.#keysByIndex(configuredKeys).values()) {
			if (eligibleKeys.has(key)) keys.add(key);
		}
		return keys;
	}

	committedViewportRangeSignature(input: {
		snapshot: VirtualListSnapshot;
		configuredKeys: readonly string[];
		position: VirtualViewportPosition | null;
		viewportSize: number;
	}): string | null {
		if (!input.position) return null;
		const committedByIndex = this.#keysByIndex(input.configuredKeys);
		const items: VirtualItem[] = [];
		for (const [index, key] of committedByIndex) {
			const item = input.snapshot.positions.itemAt(index);
			if (!item || item.key !== key) return null;
			items.push(item);
		}
		items.sort((left, right) => left.index - right.index);
		if (items.length === 0 && input.configuredKeys.length > 0) return null;
		if (
			!isConversationVirtualViewportCovered(items, {
				paintedOffset: input.position.paintedOffset,
				viewportSize: input.viewportSize,
				sizerSize: input.snapshot.sizerSize,
			})
		) {
			return null;
		}
		return items.map((item) => `${item.index}:${item.key}`).join('|');
	}

	#keysByIndex(configuredKeys: readonly string[]): Map<number, string> {
		const keysByIndex = new Map<number, string>();
		for (const element of this.#elements) {
			if (!element.isConnected) continue;
			const index = Number(element.dataset.index);
			const key = element.dataset.chatVirtualItem;
			if (!Number.isInteger(index) || key === undefined || configuredKeys[index] !== key) continue;
			keysByIndex.set(index, key);
		}
		return keysByIndex;
	}
}

export function captureConversationVirtualAnchor(input: {
	snapshot: VirtualListSnapshot;
	position: VirtualViewportPosition | null;
	keys: readonly string[];
	transcriptKeys: ReadonlySet<string>;
	preferTranscript: boolean;
}): ConversationVirtualAnchor | null {
	const paintedOffset = input.position?.paintedOffset ?? 0;
	let item: VirtualItem | undefined;
	if (input.preferTranscript) {
		const candidates: VirtualItem[] = [];
		for (let index = 0; index < input.snapshot.positions.count; index += 1) {
			const candidate = input.snapshot.positions.itemAt(index);
			if (candidate) candidates.push(candidate);
		}
		item = selectConversationReadingAnchor(candidates, paintedOffset, input.transcriptKeys);
	} else {
		item = input.snapshot.positions.itemAtOffset(paintedOffset);
	}
	if (!item) return null;
	const index = input.keys.indexOf(item.key);
	return {
		key: item.key,
		viewportOffset: item.start - paintedOffset,
		fallbackKeys: index < 0 ? [] : conversationAnchorFallbackKeys(input.keys, index),
	};
}

export function conversationAnchorFallbackKeys(keys: readonly string[], index: number): string[] {
	const fallbacks: string[] = [];
	for (let distance = 1; distance <= HIDDEN_ANCHOR_FALLBACK_RADIUS; distance += 1) {
		const before = keys[index - distance];
		const after = keys[index + distance];
		if (before) fallbacks.push(before);
		if (after) fallbacks.push(after);
	}
	return fallbacks;
}

export function conversationTargetAlignmentDelta(
	viewport: HTMLDivElement,
	node: HTMLElement,
	align: 'center' | 'start' | 'end',
): number {
	const viewportRect = viewport.getBoundingClientRect();
	const nodeRect = node.getBoundingClientRect();
	if (align === 'start') return nodeRect.top - viewportRect.top;
	if (align === 'end') return nodeRect.bottom - viewportRect.bottom;
	return nodeRect.top + nodeRect.height / 2 - (viewportRect.top + viewportRect.height / 2);
}

export function findConversationTargetNode(
	root: HTMLDivElement | null,
	rowId: string,
): HTMLElement | null {
	if (!root) return null;
	for (const candidate of root.querySelectorAll<HTMLElement>(
		'[data-chat-row-id], [data-chat-anchor-id]',
	)) {
		if (candidate.dataset.chatRowId === rowId || candidate.dataset.chatAnchorId === rowId) {
			return candidate;
		}
	}
	return null;
}

export function nextConversationAnimationFrame(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
		else queueMicrotask(resolve);
	});
}

export async function nextConversationLayoutFrame(): Promise<void> {
	await tick();
	await nextConversationAnimationFrame();
}

interface ConversationEndRestoreGeometry {
	scrollHeight: number;
	sizerSize: number;
	virtualRange: string | null;
}

export async function settleConversationEndRestore(input: {
	isCurrent(): boolean;
	readGeometry(): ConversationEndRestoreGeometry | null;
	isAtEnd(): boolean;
	scrollToEnd(): void;
	complete(): void;
}): Promise<void> {
	let previousGeometry: ConversationEndRestoreGeometry | null = null;
	let stableEndFrames = 0;
	for (let attempt = 0; attempt < MAX_END_RESTORE_ITERATIONS; attempt += 1) {
		await nextConversationLayoutFrame();
		if (!input.isCurrent()) return;
		const geometry = input.readGeometry();
		if (!geometry) return;
		const unchanged =
			previousGeometry !== null &&
			Math.abs(geometry.scrollHeight - previousGeometry.scrollHeight) <= GEOMETRY_TOLERANCE_PX &&
			Math.abs(geometry.sizerSize - previousGeometry.sizerSize) <= GEOMETRY_TOLERANCE_PX &&
			geometry.virtualRange === previousGeometry.virtualRange;
		stableEndFrames =
			input.isAtEnd() && geometry.virtualRange !== null && unchanged ? stableEndFrames + 1 : 0;
		if (stableEndFrames >= REQUIRED_END_STABLE_FRAMES) {
			input.complete();
			return;
		}
		if (!input.isAtEnd()) input.scrollToEnd();
		previousGeometry = geometry;
		if (attempt + 1 >= MAX_EARLY_END_RESTORE_ITERATIONS && geometry.virtualRange !== null) {
			input.scrollToEnd();
			input.complete();
			return;
		}
	}
	if (!input.isCurrent()) return;
	input.scrollToEnd();
	input.complete();
}

export async function measureConversationViewportFill(input: {
	keys: readonly string[];
	measuredSize(key: string): number | undefined;
	viewport(): HTMLDivElement | null;
	isCurrent(): boolean;
	restoreEnd: boolean;
	readingAnchor: ConversationVirtualAnchor | null;
	restoreReadingAnchor(anchor: ConversationVirtualAnchor): boolean;
	scrollToIndex(index: number): void;
	scrollToEnd(): void;
}): Promise<'overflow' | 'underfilled' | 'unsettled'> {
	for (let attempt = 0; attempt < MAX_EARLY_END_RESTORE_ITERATIONS; attempt += 1) {
		await nextConversationLayoutFrame();
		if (!input.isCurrent()) return 'unsettled';
		const viewport = input.viewport();
		if (!viewport) return 'unsettled';
		const classification = classifyMeasuredConversationViewportFill({
			keys: input.keys,
			measuredSizes: { get: input.measuredSize },
			viewportHeight: viewport.clientHeight,
		});
		if (classification) {
			if (input.restoreEnd) input.scrollToEnd();
			else if (input.readingAnchor && !input.restoreReadingAnchor(input.readingAnchor)) {
				return 'unsettled';
			}
			return classification;
		}
		const nextUnmeasuredIndex = input.keys.findIndex(
			(key) => input.measuredSize(key) === undefined,
		);
		if (nextUnmeasuredIndex < 0) return 'unsettled';
		input.scrollToIndex(nextUnmeasuredIndex);
	}
	if (input.restoreEnd && input.isCurrent()) input.scrollToEnd();
	else if (input.readingAnchor) input.restoreReadingAnchor(input.readingAnchor);
	return 'unsettled';
}

export async function settleConversationTarget(input: {
	root(): HTMLDivElement | null;
	rowId: string;
	viewport(): HTMLDivElement | null;
	align: 'center' | 'start' | 'end';
	isCurrent(): boolean;
	isReady(): boolean;
	scrollBy(delta: number): void;
	onSettledNode(node: HTMLElement): void;
}): Promise<'completed' | 'cancelled' | 'not-ready'> {
	let previousRect: { top: number; height: number } | null = null;
	let stableFrames = 0;
	for (let attempt = 0; attempt < MAX_TARGET_SETTLE_ITERATIONS; attempt += 1) {
		await nextConversationLayoutFrame();
		if (!input.isCurrent()) return 'cancelled';
		if (!input.isReady()) return 'not-ready';
		const node = findConversationTargetNode(input.root(), input.rowId);
		if (!node) continue;
		if (!isConversationTargetLayoutReady(node)) {
			previousRect = null;
			stableFrames = 0;
			continue;
		}
		input.onSettledNode(node);
		const viewport = input.viewport();
		if (!viewport) return 'not-ready';
		const alignmentDelta = conversationTargetAlignmentDelta(viewport, node, input.align);
		const attainableOffset = attainableConversationTargetOffset({
			currentOffset: viewport.scrollTop,
			alignmentDelta,
			maximumOffset: Math.max(viewport.scrollHeight - viewport.clientHeight, 0),
		});
		const attainableDelta = attainableOffset - viewport.scrollTop;
		if (Math.abs(attainableDelta) > CHAT_GEOMETRY_END_THRESHOLD_PX) {
			input.scrollBy(attainableDelta);
			previousRect = null;
			stableFrames = 0;
			continue;
		}
		const nodeRect = node.getBoundingClientRect();
		const viewportRect = viewport.getBoundingClientRect();
		const currentRect = { top: nodeRect.top - viewportRect.top, height: nodeRect.height };
		const stable =
			previousRect !== null &&
			Math.abs(currentRect.top - previousRect.top) <= GEOMETRY_TOLERANCE_PX &&
			Math.abs(currentRect.height - previousRect.height) <= GEOMETRY_TOLERANCE_PX;
		stableFrames = stable ? stableFrames + 1 : 0;
		previousRect = currentRect;
		if (stableFrames >= 2) return 'completed';
	}
	return 'not-ready';
}
