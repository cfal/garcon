import type { SvelteVirtualizer } from '@tanstack/svelte-virtual';
import { selectConversationReadingAnchor } from './conversation-feed-viewport-geometry.js';

const HIDDEN_ANCHOR_FALLBACK_RADIUS = 8;

export interface ConversationVirtualAnchor {
	key: string;
	offsetWithinItem: number;
	fallbackKeys: readonly string[];
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
	return { key: item.key, offsetWithinItem: offset - item.start, fallbackKeys };
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
