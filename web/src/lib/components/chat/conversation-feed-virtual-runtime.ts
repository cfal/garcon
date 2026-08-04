import type { SvelteVirtualizer } from '@tanstack/svelte-virtual';
import { tick } from 'svelte';

const HIDDEN_ANCHOR_FALLBACK_RADIUS = 8;

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

export async function resetMountedConversationMeasurements(
	instance: SvelteVirtualizer<HTMLElement, HTMLDivElement>,
	getRoot: () => HTMLDivElement | null,
	canMeasure: () => boolean,
	canMeasureDuringScroll: () => boolean,
): Promise<boolean> {
	instance.measure();
	await tick();
	await nextConversationAnimationFrame();
	if (!canMeasure()) return false;
	if (!getRoot()) return false;

	const measureCurrentElements = (): boolean => {
		const root = getRoot();
		if (!root) return false;
		const elements = [...root.children].filter((element): element is HTMLDivElement =>
			element.hasAttribute('data-chat-virtual-item'),
		);
		for (const element of elements) instance.measureElement(element);
		return elements.every((element) => {
			const key = element.dataset.chatVirtualItem;
			return key !== undefined && instance.itemSizeCache.has(key);
		});
	};

	const remeasureWhenAllowed = async (): Promise<boolean> => {
		// Core ignores manual measurements during native scrolling. A programmatic restore opens
		// that gate, while uninterrupted user scrolling retains estimates until it settles.
		while (instance.isScrolling) {
			if (!canMeasure()) return false;
			if (canMeasureDuringScroll() && measureCurrentElements()) return true;
			await nextConversationAnimationFrame();
		}
		if (!canMeasure()) return false;
		// Remeasures surviving keyed nodes because their Svelte attachments do not rerun after shrink.
		return measureCurrentElements();
	};

	if (instance.isScrolling) {
		void remeasureWhenAllowed();
		return true;
	}
	return remeasureWhenAllowed();
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
