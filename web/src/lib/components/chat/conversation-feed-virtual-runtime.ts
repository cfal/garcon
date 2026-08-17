import { tick } from 'svelte';
import {
	observeElementRect,
	type Rect,
	type SvelteVirtualizer,
	type VirtualItem,
	type Virtualizer,
} from '@tanstack/svelte-virtual';
import {
	attainableConversationTargetOffset,
	CHAT_GEOMETRY_END_THRESHOLD_PX,
	classifyMeasuredConversationViewportFill,
	isConversationVirtualViewportCovered,
	isConversationTargetLayoutReady,
	resolveConversationViewportRect,
	selectConversationReadingAnchor,
} from './conversation-feed-viewport-geometry.js';

const HIDDEN_ANCHOR_FALLBACK_RADIUS = 8;
const MAX_END_RESTORE_ITERATIONS = 60;
const MAX_EARLY_END_RESTORE_ITERATIONS = 8;
const MAX_ANCHOR_SETTLE_ITERATIONS = 8;
const MAX_TARGET_SETTLE_ITERATIONS = 180;
const REQUIRED_END_STABLE_FRAMES = 2;
const GEOMETRY_TOLERANCE_PX = 0.5;

export interface ConversationVirtualAnchor {
	key: string;
	viewportOffset: number;
	fallbackKeys: readonly string[];
}

export interface ConversationVirtualAnchorSettlePort {
	readonly options: { readonly scrollMargin: number };
	cancelScroll(): void;
	getVirtualItems(): VirtualItem[];
	scrollToIndex(index: number, options: { align: 'start'; behavior: 'auto' }): void;
	scrollToOffset(offset: number, options: { behavior: 'auto' }): void;
}

export class ConversationProgrammaticScrollOwnership {
	#active = false;
	#epoch = 0;

	get ownsPosition(): boolean {
		return this.#active;
	}

	begin(): number {
		this.#active = true;
		return ++this.#epoch;
	}

	cancel(): void {
		this.#active = false;
		this.#epoch += 1;
	}

	isCurrent(epoch: number): boolean {
		return epoch === this.#epoch;
	}

	finish(epoch: number): void {
		if (!this.isCurrent(epoch)) return;
		this.#active = false;
	}
}

// Keeps clamped prepend provenance with the bounded keyed restore so coasting and
// edge-origin scrollbar drags survive its programmatic offset writes.
export class ConversationEarlierPrependAnchorOwnership {
	#anchor: ConversationVirtualAnchor | null = null;
	#clamped = false;
	#publicationBeganClamped = false;
	#blocksScrollbarDrag = false;
	// Prepend measurements can move TanStack's range repeatedly before settlement. Once mounted,
	// a row stays sticky for that restore so Svelte never destroys and recreates a visible node.
	#retainedMountedRowKeys: Set<string> | null = null;

	get retainedMountedRowKeys(): ReadonlySet<string> | null {
		return this.#retainedMountedRowKeys;
	}

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
		} else if (this.#anchor !== anchor) {
			this.clear();
		}
	}

	preserves(
		direction: 'earlier' | 'later' | null,
		anchor: ConversationVirtualAnchor | null,
		scrollTop: number,
		source: 'viewport' | 'scrollbar-drag' = 'viewport',
	): boolean {
		if (source === 'scrollbar-drag' && this.#blocksScrollbarDrag) {
			if (direction !== 'later') return true;
			this.#blocksScrollbarDrag = false;
		}
		if (!anchor) {
			return this.#publicationBeganClamped && direction !== 'later';
		}
		if (this.#anchor !== anchor) return false;
		// A directionless press is stateless; its movement is classified before scrolling.
		if (direction === null) return true;
		if (direction !== 'earlier') return false;
		if (!this.#clamped && scrollTop > CHAT_GEOMETRY_END_THRESHOLD_PX) {
			return false;
		}
		this.#clamped = true;
		return true;
	}

	blocksViewportMutation(source: 'viewport' | 'scrollbar-drag'): boolean {
		return source === 'scrollbar-drag' && this.#blocksScrollbarDrag;
	}

	finishScrollbarDrag(): void {
		this.#blocksScrollbarDrag = false;
	}

	complete(anchor: ConversationVirtualAnchor): void {
		if (this.#anchor !== anchor) return;
		this.#anchor = null;
		this.#clamped = false;
		this.#publicationBeganClamped = false;
		this.#retainedMountedRowKeys = null;
	}
}

// TanStack includes scrollMargin in item.start while the rendered row transform removes it.
export function conversationAnchorViewportOffset(
	itemStart: number,
	scrollMargin: number,
	scrollOffset: number,
): number {
	return itemStart - scrollMargin - scrollOffset;
}

export function conversationAnchorScrollOffset(
	itemStart: number,
	scrollMargin: number,
	viewportOffset: number,
): number {
	return itemStart - scrollMargin - viewportOffset;
}

export function positionCommittedConversationAnchor(input: {
	element: HTMLElement;
	viewport: HTMLElement;
	viewportOffset: number;
	scrollToOffset(offset: number): void;
}): void {
	const elementOffset =
		input.element.getBoundingClientRect().top - input.viewport.getBoundingClientRect().top;
	const correction = elementOffset - input.viewportOffset;
	if (Math.abs(correction) <= GEOMETRY_TOLERANCE_PX) return;
	input.scrollToOffset(Math.max(0, input.viewport.scrollTop + correction));
}

export function positionPendingConversationAnchor(input: {
	anchor: ConversationVirtualAnchor | null;
	element: HTMLElement;
	virtualItem: { key: unknown; index: number };
	indexByKey: ReadonlyMap<string, number>;
	viewport: HTMLElement | null;
	scrollToOffset(offset: number): void;
}): void {
	if (!input.anchor || !input.viewport) return;
	const key = [input.anchor.key, ...input.anchor.fallbackKeys].find((candidate) =>
		input.indexByKey.has(candidate),
	);
	if (
		!input.element.isConnected ||
		key !== String(input.virtualItem.key) ||
		input.indexByKey.get(key) !== input.virtualItem.index ||
		input.element.dataset.chatVirtualItem !== key ||
		Number(input.element.dataset.index) !== input.virtualItem.index
	) {
		return;
	}
	positionCommittedConversationAnchor({
		element: input.element,
		viewport: input.viewport,
		viewportOffset: key === input.anchor.key ? input.anchor.viewportOffset : 0,
		scrollToOffset: input.scrollToOffset,
	});
}

export class ConversationPreCommitAnchorBuffer {
	#revision: number | null = null;
	#nearest: ConversationVirtualAnchor | null = null;
	#transcript: ConversationVirtualAnchor | null = null;

	capture(
		revision: number,
		captureAnchor: (preferTranscript: boolean) => ConversationVirtualAnchor | null,
	): void {
		this.#revision = revision;
		this.#nearest = captureAnchor(false);
		this.#transcript = captureAnchor(true);
	}

	take(revision: number, preferTranscript: boolean): ConversationVirtualAnchor | null {
		const anchor =
			revision === this.#revision ? (preferTranscript ? this.#transcript : this.#nearest) : null;
		this.clear();
		return anchor;
	}

	clear(): void {
		this.#revision = null;
		this.#nearest = null;
		this.#transcript = null;
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

	committedVirtualItem(
		instance: Pick<ConversationVirtualAnchorSettlePort, 'getVirtualItems'>,
		configuredKeys: readonly string[],
		key: string,
	): VirtualItem | undefined {
		const committedByIndex = this.#keysByIndex(configuredKeys);
		return instance
			.getVirtualItems()
			.find((item) => String(item.key) === key && committedByIndex.get(item.index) === key);
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

	committedViewportRangeSignature(
		instance: SvelteVirtualizer<HTMLElement, HTMLDivElement>,
		configuredKeys: readonly string[],
		viewport: HTMLDivElement | null,
	): string | null {
		if (!viewport) return null;
		const virtualItems = instance.getVirtualItems();
		if (virtualItems.length === 0 && configuredKeys.length > 0) return null;
		const committedByIndex = this.#keysByIndex(configuredKeys);
		for (const item of virtualItems) {
			if (committedByIndex.get(item.index) !== String(item.key)) return null;
		}
		if (
			!isConversationVirtualViewportCovered(virtualItems, {
				scrollOffset: viewport.scrollTop,
				viewportSize: viewport.clientHeight,
				scrollMargin: instance.options.scrollMargin,
				totalSize: instance.getTotalSize(),
			})
		) {
			return null;
		}
		return virtualItems.map((item) => `${item.index}:${String(item.key)}`).join('|');
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

export async function settleConversationVirtualAnchor(input: {
	instance: ConversationVirtualAnchorSettlePort;
	mountedItems: ConversationMountedVirtualItems;
	configuredKeys: readonly string[];
	key: string;
	index: number;
	viewportOffset: number;
	readScrollOffset(): number | null;
	isCurrent(): boolean;
}): Promise<boolean> {
	for (let attempt = 0; attempt < MAX_ANCHOR_SETTLE_ITERATIONS; attempt += 1) {
		await nextConversationLayoutFrame();
		if (!input.isCurrent()) return false;
		const item = input.mountedItems.committedVirtualItem(
			input.instance,
			input.configuredKeys,
			input.key,
		);
		if (!item) {
			// An index target remains valid while an offscreen or retained wrapper materializes.
			input.instance.scrollToIndex(input.index, { align: 'start', behavior: 'auto' });
			continue;
		}
		const scrollOffset = conversationAnchorScrollOffset(
			item.start,
			input.instance.options.scrollMargin,
			input.viewportOffset,
		);
		const currentOffset = input.readScrollOffset();
		if (currentOffset === null || Math.abs(currentOffset - scrollOffset) > GEOMETRY_TOLERANCE_PX) {
			input.instance.scrollToOffset(scrollOffset, { behavior: 'auto' });
		}
		await nextConversationAnimationFrame();
		if (!input.isCurrent()) return false;
		const settledItem = input.instance
			.getVirtualItems()
			.find((candidate) => candidate.key === input.key);
		const settledOffset = input.readScrollOffset();
		if (
			settledItem &&
			settledOffset != null &&
			Math.abs(
				settledOffset -
					conversationAnchorScrollOffset(
						settledItem.start,
						input.instance.options.scrollMargin,
						input.viewportOffset,
					),
			) <= GEOMETRY_TOLERANCE_PX
		) {
			input.instance.cancelScroll();
			return true;
		}
	}
	return false;
}

export function captureConversationVirtualAnchor(input: {
	instance: SvelteVirtualizer<HTMLElement, HTMLDivElement>;
	viewport: HTMLDivElement | null;
	keys: readonly string[];
	transcriptKeys: ReadonlySet<string>;
	preferTranscript: boolean;
}): ConversationVirtualAnchor | null {
	const offset = input.viewport?.scrollTop ?? input.instance.scrollOffset ?? 0;
	// Prefix controls occupy offset zero, so history prepends preserve the nearest message instead.
	const item = input.preferTranscript
		? selectConversationReadingAnchor(
				input.instance.getVirtualItems(),
				offset,
				input.transcriptKeys,
			)
		: input.instance.getVirtualItemForOffset(offset);
	if (!item || typeof item.key !== 'string') return null;
	const index = input.keys.indexOf(item.key);
	const fallbackKeys = index < 0 ? [] : conversationAnchorFallbackKeys(input.keys, index);
	return {
		key: item.key,
		viewportOffset: conversationAnchorViewportOffset(
			item.start,
			input.instance.options.scrollMargin,
			offset,
		),
		fallbackKeys,
	};
}

export function observeConversationRootOffset(
	viewport: HTMLDivElement,
	root: HTMLDivElement,
	applyMargin: (margin: number) => void,
): (() => void) | undefined {
	const update = (): void =>
		applyMargin(
			root.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop,
		);
	update();
	if (typeof ResizeObserver === 'undefined') return;
	const observer = new ResizeObserver(update);
	observer.observe(viewport);
	observer.observe(root);
	return () => observer.disconnect();
}

export function createConversationElementRectObserver(initialRect: Rect) {
	let lastRect = initialRect;
	return (
		instance: Virtualizer<HTMLElement, HTMLDivElement>,
		callback: (rect: Rect) => void,
	): (() => void) => {
		const cleanup = observeElementRect(instance, (rect) => {
			lastRect = resolveConversationViewportRect(lastRect, rect);
			callback(lastRect);
		});
		return cleanup ?? (() => {});
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
	totalSize: number;
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
			Math.abs(geometry.totalSize - previousGeometry.totalSize) <= GEOMETRY_TOLERANCE_PX &&
			geometry.virtualRange === previousGeometry.virtualRange;
		stableEndFrames =
			input.isAtEnd() && geometry.virtualRange !== null && unchanged ? stableEndFrames + 1 : 0;
		if (stableEndFrames >= REQUIRED_END_STABLE_FRAMES) {
			input.complete();
			return;
		}
		// Core updates before Svelte commits the enlarged sizer and rows, so reveal waits
		// for stable geometry and an attached wrapper for every item in the current range.
		if (!input.isAtEnd()) input.scrollToEnd();
		previousGeometry = geometry;
		if (attempt + 1 >= MAX_EARLY_END_RESTORE_ITERATIONS && geometry.virtualRange !== null) {
			// Streaming may prevent equal sizes indefinitely. A committed range can reveal
			// after one final physical-end write without exposing a gap.
			input.scrollToEnd();
			input.complete();
			return;
		}
	}
	if (!input.isCurrent()) return;
	// A broken row commit cannot conceal the conversation indefinitely. The extended
	// bound gives Svelte a full second at 60 Hz before the final liveness fallback.
	input.scrollToEnd();
	input.complete();
}

export async function settleConversationScroll(input: {
	isCurrent(): boolean;
	readOffset(): number | null;
}): Promise<void> {
	let previousOffset: number | null = null;
	for (let attempt = 0; attempt < MAX_EARLY_END_RESTORE_ITERATIONS; attempt += 1) {
		await nextConversationLayoutFrame();
		if (!input.isCurrent()) return;
		const offset = input.readOffset();
		if (
			offset === null ||
			(previousOffset !== null && Math.abs(previousOffset - offset) <= GEOMETRY_TOLERANCE_PX)
		) {
			return;
		}
		previousOffset = offset;
	}
}

export async function measureConversationViewportFill(input: {
	instance: SvelteVirtualizer<HTMLElement, HTMLDivElement>;
	keys: readonly string[];
	renderedKeys: ReadonlySet<string>;
	estimates: readonly number[];
	leadingSize: number;
	viewport(): HTMLDivElement | null;
	isCurrent(): boolean;
	restoreEnd: boolean;
	readingAnchor: ConversationVirtualAnchor | null;
	restoreReadingAnchor(anchor: ConversationVirtualAnchor): Promise<boolean>;
	scrollToEnd(): void;
}): Promise<'overflow' | 'underfilled' | 'unsettled'> {
	for (let attempt = 0; attempt < MAX_EARLY_END_RESTORE_ITERATIONS; attempt += 1) {
		await nextConversationLayoutFrame();
		if (!input.isCurrent()) return 'unsettled';
		const viewport = input.viewport();
		if (!viewport) return 'unsettled';
		const classification = classifyMeasuredConversationViewportFill({
			keys: input.keys,
			measuredSizes: input.instance.itemSizeCache,
			renderedKeys: input.renderedKeys,
			estimates: input.estimates,
			leadingSize: input.leadingSize,
			viewportHeight: viewport.clientHeight,
		});
		if (classification) {
			if (input.restoreEnd) input.scrollToEnd();
			else if (input.readingAnchor && !(await input.restoreReadingAnchor(input.readingAnchor))) {
				return 'unsettled';
			}
			return classification;
		}
		const nextUnmeasuredIndex = input.keys.findIndex(
			(key) => !input.instance.itemSizeCache.has(key) && !input.renderedKeys.has(key),
		);
		if (nextUnmeasuredIndex < 0) return 'unsettled';
		input.instance.scrollToIndex(nextUnmeasuredIndex, { align: 'start', behavior: 'auto' });
	}
	if (input.restoreEnd && input.isCurrent()) input.scrollToEnd();
	else if (input.readingAnchor) await input.restoreReadingAnchor(input.readingAnchor);
	return 'unsettled';
}

export async function performConversationOwnedScroll(input: {
	begin(): number;
	finish(epoch: number): void;
	isCurrent(epoch: number): boolean;
	isValid(): boolean;
	readOffset(): number | null;
	write(): void;
}): Promise<boolean> {
	if (!input.isValid()) return false;
	const epoch = input.begin();
	try {
		if (!input.isValid() || !input.isCurrent(epoch)) return false;
		input.write();
		await settleConversationScroll({
			isCurrent: () => input.isValid() && input.isCurrent(epoch),
			readOffset: input.readOffset,
		});
		return true;
	} finally {
		input.finish(epoch);
	}
}

export async function settleConversationTarget(input: {
	root(): HTMLDivElement | null;
	rowId: string;
	viewport(): HTMLDivElement | null;
	align: 'center' | 'start' | 'end';
	isCurrent(): boolean;
	isReady(): boolean;
	scrollToOffset(offset: number): void;
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
		const viewport = input.viewport();
		if (!viewport) return 'not-ready';
		const attainableOffset = attainableConversationTargetOffset({
			currentOffset: viewport.scrollTop,
			alignmentDelta: conversationTargetAlignmentDelta(viewport, node, input.align),
			maximumOffset: Math.max(viewport.scrollHeight - viewport.clientHeight, 0),
		});
		if (Math.abs(attainableOffset - viewport.scrollTop) > CHAT_GEOMETRY_END_THRESHOLD_PX) {
			input.scrollToOffset(attainableOffset);
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

export function sameConversationNumberArrays(
	left: readonly number[],
	right: readonly number[],
): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function scrollConversationToPhysicalEnd(
	instance: SvelteVirtualizer<HTMLElement, HTMLDivElement>,
	viewport: HTMLDivElement | null,
): void {
	if (!viewport) return;
	// Count growth can turn TanStack's retained last-index target into an interior target.
	instance.scrollToOffset(Math.max(viewport.scrollHeight - viewport.clientHeight, 0), {
		behavior: 'auto',
	});
}
