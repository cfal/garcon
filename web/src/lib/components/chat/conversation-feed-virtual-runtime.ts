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
	isConversationTargetLayoutReady,
	resolveConversationViewportRect,
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

	committedRangeSignature(
		virtualItems: readonly VirtualItem[],
		configuredKeys: readonly string[],
	): string | null {
		if (virtualItems.length === 0 && configuredKeys.length > 0) return null;
		const committedByIndex = this.#keysByIndex(configuredKeys);
		for (const item of virtualItems) {
			if (committedByIndex.get(item.index) !== String(item.key)) return null;
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
